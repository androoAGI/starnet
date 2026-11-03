/* node test/channels.ledger-migration.test.js — the v1 delivery files (inbox.json, outbox.json) move into the delivery
   ledger (channels/delivery.json) EXACTLY ONCE, fail-soft, and an older build reading what is left resends nothing.

   An upgrade can find replies the old outbox still owed and messages the old inbox was still holding (with how far their
   run got, and a finished answer the full outbox had refused). Each must become exactly one ledger record; the v1 files
   must then read as valid EMPTY envelopes, mains and .bak alike, so a downgrade neither replays nor resends; a crash
   between the two writes must change nothing on the next boot; and a busy file must never throw out of the store (it is
   built at the host's module load) nor lose anything. Real store over an in-memory disk that can refuse any read or
   write once. The store runs the migration itself when it is built (the host builds it at module load). Proves:
     A. each v1 inbox item (its attempt kept) becomes one receipt; a held answer becomes one delivery that settles every
        receipt its run answered; each v1 outbox item becomes one queued delivery (its '⌛ delayed reply' text and tries
        kept), ahead of newer work in its chat; the four v1 files are then exactly { version:1, items:[] }; chatmap.json
        is byte-identical (its unreachable flags stay for an older build)
     B. a crash between the ledger write and the v1 truncation: the next boot takes nothing twice and finishes emptying
     C. a second upgrade, after an older build queued new v1 items, migrates only those — a reused edit id included
     D. every read and write of the migration throwing once (EBUSY, EPERM, UPDATE_MUTATIONS_FROZEN): the store still
        works, nothing is lost, and the retry finishes the migration
     E. through REAL hubs, each migrated item is then delivered or replayed exactly once: the queued replies land once (in
        their chat's order, the older first), the held answer lands once and nothing re-runs, a plain receipt runs once,
        a receipt whose run had begun tool steps gets the interrupted notice and never runs, and the ledger ends empty */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path').posix;
const { makeChannelStore } = require('../sidecar/channels/store.js');

const ROOT = '/ws/channels';
const T0 = 1761900000000;
const EMPTY = JSON.stringify({ version: 1, items: [] });
const HEADER = '⌛ delayed reply — the channel was unreachable when this was first sent:';

function memFs() {
  const files = new Map();
  const faults = [];
  const err = (code, p) => Object.assign(new Error(code + ': simulated, ' + p), { code: code });
  const hit = (op, p) => {
    for (let i = 0; i < faults.length; i++) {
      const f = faults[i];
      if (f.op !== op || !p.endsWith('/' + f.file)) continue;
      if (++f.seen === f.nth) { faults.splice(i, 1); throw err(f.code, p); }
    }
  };
  return {
    files, faults,
    fail(op, file, code, nth) { faults.push({ op: op, file: file, code: code, nth: nth || 1, seen: 0 }); },
    readFileSync(p) { hit('read', p); if (!files.has(p)) throw err('ENOENT', p); return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { hit('rename', b); if (!files.has(a)) throw err('ENOENT', a); files.set(b, files.get(a)); files.delete(a); },
    linkSync(a, b) { if (!files.has(a)) throw err('ENOENT', a); if (files.has(b)) throw err('EEXIST', b); files.set(b, files.get(a)); },
    unlinkSync(p) { if (!files.has(p)) throw err('ENOENT', p); files.delete(p); },
    mkdirSync() {}
  };
}
function fakeTimers() {
  const list = [];
  return { list, setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; list.push(t); return t; }, clearTimeout(t) { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
    fire() { const due = list.splice(0); for (const t of due) t.fn(); } };
}
const dm = (channel, chatId, mid, text, extra) => Object.assign({ channel: channel, chatId: String(chatId), chatType: 'dm', userId: 'u1', text: text, messageId: String(mid), ts: 1 }, extra || {});
const held = { text: 'The finished answer.', runId: 'old-run-3', reason: 'done', agentId: 'tg_4242', ids: ['telegram|4242|3', 'telegram|4242|4'] };
const V1_INBOX = [
  { id: 'telegram|4242|1', channel: 'telegram', message: dm('telegram', 4242, 1, 'plain'), ts: T0 - 5000 },
  { id: 'telegram|4242|2', channel: 'telegram', message: dm('telegram', 4242, 2, 'with tools'), ts: T0 - 4000, attempt: { runId: 'old-run-2', tools: 2, boot: 'old-boot' } },
  { id: 'telegram|4242|3', channel: 'telegram', message: dm('telegram', 4242, 3, 'first half'), ts: T0 - 3000, attempt: { runId: 'old-run-3', tools: 1, boot: 'old-boot' }, held: held },
  { id: 'telegram|4242|4', channel: 'telegram', message: dm('telegram', 4242, 4, 'second half'), ts: T0 - 3000, attempt: { runId: 'old-run-3', tools: 1, boot: 'old-boot' }, held: held },
  { id: 'telegram|4242|5|edited', channel: 'telegram', message: dm('telegram', 4242, 5, 'corrected', { edited: true }), ts: T0 - 2000 },
  { id: 'discord|99|7', channel: 'discord', message: dm('discord', 99, 7, 'from discord'), ts: T0 - 1500 }
];
const V1_OUTBOX = [
  { id: '1761899990000-1', channel: 'telegram', chatId: '4242', text: HEADER + '\nThe late answer.', runId: 'old-run-1', agentId: 'tg_4242', reason: 'done', ts: T0 - 10000, tries: 3 },
  { id: '1761899990000-2', channel: 'discord', chatId: '99', text: HEADER + '\nDiscord, late.', runId: 'old-run-9', agentId: '', reason: 'done', ts: T0 - 9000, tries: 0 }
];
const CHATMAP = JSON.stringify({ version: 1, chats: { 4242: { agentId: 'tg_4242', channel: 'telegram', unreachable: true, interruptedAttempt: { runId: 'x', tools: 1 }, lastSeen: T0 - 60000 } } });

function seeded() {
  const fs = memFs();
  fs.files.set(ROOT + '/inbox.json', JSON.stringify({ version: 1, items: V1_INBOX }));
  fs.files.set(ROOT + '/outbox.json', JSON.stringify({ version: 1, items: V1_OUTBOX }));
  fs.files.set(ROOT + '/chatmap.json', CHATMAP);
  return fs;
}
const boot = (fs, timers, extra) => makeChannelStore(Object.assign({ fs, pathMod, root: ROOT, clock: { now: () => T0 }, timers: timers || fakeTimers(), bootId: 'boot-new' }, extra || {}));
const diskDoc = (fs) => JSON.parse(fs.files.get(ROOT + '/delivery.json') || 'null');
const v1Files = ['inbox.json', 'inbox.json.bak', 'outbox.json', 'outbox.json.bak'];
// what an older build's v1 reader finds: every one of the four files a valid, empty envelope
const v1Empty = (fs) => v1Files.every(f => fs.files.get(ROOT + '/' + f) === EMPTY);
// the record set the ledger must end with (ids, plus the fields a v1 item carried), whatever path got it there
function shape(doc) {
  if (!doc) return null;
  return {
    receipts: doc.receipts.map(r => [r.id, r.channel, r.chatId, r.message.text, r.attempt]).sort((a, b) => a[0] < b[0] ? -1 : 1),
    deliveries: doc.deliveries.map(d => [d.id, d.chat, d.text, d.delayed, d.tries, d.receiptIds, d.state]),
    migrated: [doc.migrated.inbox.length, doc.migrated.outbox.length]
  };
}
const migrate = (store) => (typeof store.migrateV1 === 'function' ? store.migrateV1() : null);
// did the BOOT finish the migration? (the store runs it when it is built; a tree without the ledger never does)
const bootMigrated = (store) => !!(store._internals && store._internals.migration && store._internals.migration.done);

(async () => {
  // ---- A. one upgrade: each item exactly one record; the v1 files empty; chatmap.json untouched ----
  let WANT = null;
  {
    const fs = seeded();
    const store = boot(fs);
    A.eq(bootMigrated(store), true, 'building the store migrates the v1 files (it runs before any hub attaches)');
    A.eq(migrate(store), true, 'and asked again it has nothing left to do');
    const doc = diskDoc(fs);
    A.ok(!!doc, 'channels/delivery.json is written');
    const rec = (id) => doc && doc.receipts.find(r => r.id === id);
    A.eq(doc && doc.receipts.map(r => r.id).sort(), ['discord|99|7', 'telegram|4242|1', 'telegram|4242|2', 'telegram|4242|5|edited'], 'every pending v1 receipt is one ledger receipt with the same id; the two a held answer settled are not');
    A.eq(rec('telegram|4242|2') && rec('telegram|4242|2').attempt, { runId: 'old-run-2', tools: 2, boot: 'old-boot', replays: 0 }, 'a receipt keeps how far its run got (the attempt rule applies: an upgrade is a restart)');
    A.eq(rec('telegram|4242|1') && rec('telegram|4242|1').attempt, null, 'a receipt that never reached a run has no attempt');
    const heldD = doc && doc.deliveries.find(d => d.id === 'reply:old-run-3');
    A.ok(!!heldD && heldD.text === 'The finished answer.' && JSON.stringify(heldD.receiptIds) === JSON.stringify(held.ids), 'the held answer is one delivery answering both receipts of its run (sent, never re-run)');
    const o1 = doc && doc.deliveries.find(d => d.id === '1761899990000-1');
    A.ok(!!o1 && o1.text === V1_OUTBOX[0].text && o1.delayed === true && o1.tries === 3 && o1.chat === 'telegram|4242' && o1.parts.length === 0,
      'a v1 outbox item is one queued delivery: same id, its delayed-reply text and tries, cut at its first send');
    A.eq(doc && doc.deliveries.filter(d => d.chat === 'telegram|4242').map(d => d.id), ['1761899990000-1', 'reply:old-run-3'], 'in its chat lane by original time, the older queued reply first');
    A.eq(doc && doc.deliveries.filter(d => d.chat === 'discord|99').map(d => d.id), ['1761899990000-2'], 'per channel: the Discord reply is its own lane');
    A.ok(v1Empty(fs), 'inbox.json, outbox.json and both .bak are valid empty v1 envelopes: an older build replays and resends nothing');
    A.eq(fs.files.get(ROOT + '/chatmap.json'), CHATMAP, 'chatmap.json is byte-identical (its unreachable flags stay for an older build)');
    A.eq(migrate(boot(fs)), true, 'a second boot over the migrated directory finds nothing to do');
    A.eq(shape(diskDoc(fs)), shape(doc), 'and changes nothing');
    WANT = shape(doc);
  }

  // ---- B. a crash between the ledger write and the truncation is idempotent ----
  {
    const fs = seeded();
    fs.fail('rename', 'inbox.json.bak', 'EBUSY');   // the process "dies" there: the first emptying write never lands
    const first = boot(fs);
    A.eq(bootMigrated(first), false, 'fixture: the boot\'s migration stopped after the ledger write');
    A.eq(shape(diskDoc(fs)), WANT, 'the ledger already holds every item');
    A.ok(JSON.parse(fs.files.get(ROOT + '/inbox.json')).items.length === V1_INBOX.length, 'and the v1 files still hold them');
    const next = boot(fs);   // the restart
    A.eq(bootMigrated(next), true, 'the next boot finishes');
    A.eq(shape(diskDoc(fs)), WANT, 'taking nothing twice');
    A.ok(v1Empty(fs), 'and empties the v1 files');
  }

  // ---- C. a second upgrade migrates only what an older build queued since (a reused edit id included) ----
  {
    const fs = seeded();
    A.eq(migrate(boot(fs)), true, 'fixture: the first upgrade');
    // the downgrade: an older build answers nothing from delivery.json and queues new v1 items of its own
    const later = [
      { id: 'telegram|4242|8', channel: 'telegram', message: dm('telegram', 4242, 8, 'asked on the older build'), ts: T0 + 1000 },
      { id: 'telegram|4242|5|edited', channel: 'telegram', message: dm('telegram', 4242, 5, 'corrected AGAIN', { edited: true }), ts: T0 + 2000 }
    ];
    const laterOut = [{ id: '1761900003000-1', channel: 'telegram', chatId: '4242', text: HEADER + '\nOlder build, late.', runId: 'down-run', agentId: '', reason: 'done', ts: T0 + 3000, tries: 1 }];
    fs.files.set(ROOT + '/inbox.json', JSON.stringify({ version: 1, items: later }));
    fs.files.set(ROOT + '/outbox.json', JSON.stringify({ version: 1, items: laterOut }));
    A.eq(migrate(boot(fs)), true, 'the second upgrade finishes');
    const doc = diskDoc(fs);
    const ids = doc.receipts.map(r => r.id).sort();
    A.eq(ids, ['discord|99|7', 'telegram|4242|1', 'telegram|4242|2', 'telegram|4242|5|edited', 'telegram|4242|5|edited#' + (T0 + 2000), 'telegram|4242|8'],
      'only the new items are added; the reused edit id (no edit date in v1) is a NEW receipt beside the first');
    A.eq(doc.deliveries.map(d => d.id).filter(id => id === '1761900003000-1').length, 1, 'the older build\'s queued reply is one delivery');
    A.eq(doc.deliveries.length, WANT.deliveries.length + 1, 'and nothing earlier is duplicated');
    A.ok(v1Empty(fs), 'the v1 files are empty again');
  }

  // ---- D. every read and write of the migration refused once: a working store, nothing lost, finished on the retry ----
  {
    const points = [['read', 'inbox.json', 1], ['read', 'outbox.json', 1], ['read', 'delivery.json', 1], ['rename', 'delivery.json', 1],
      ['read', 'delivery.json', 2], ['read', 'delivery.json', 3], ['rename', 'inbox.json.bak', 1], ['rename', 'inbox.json', 1],
      ['rename', 'outbox.json.bak', 1], ['rename', 'outbox.json', 1]];
    let rows = 0, bad = [];
    for (const code of ['EBUSY', 'EPERM', 'UPDATE_MUTATIONS_FROZEN']) {
      for (const [op, file, nth] of points) {
        const fs = seeded();
        fs.fail(op, file, code, nth);
        const timers = fakeTimers();
        let store = null, threw = null, first = null;
        try { store = boot(fs, timers); first = migrate(store); } catch (e) { threw = e; }
        const label = code + ' on ' + op + ' ' + file + (nth > 1 ? ' #' + nth : '');
        if (threw) { bad.push(label + ': threw ' + threw.message); continue; }
        try { store.saveChatRecord('5150', { agentId: 'tg_5150' }); if (store.getChatRecord('5150').agentId !== 'tg_5150') bad.push(label + ': the store does not work'); }
        catch (e) { bad.push(label + ': the store does not work: ' + e.message); }
        for (let i = 0; i < 8 && !store._internals.migration.done; i++) timers.fire();   // the migration's own retry timer
        if (!store._internals.migration.done) bad.push(label + ': the retry never finished');
        else if (JSON.stringify(shape(diskDoc(fs))) !== JSON.stringify(WANT)) bad.push(label + ': the ledger ended ' + JSON.stringify(shape(diskDoc(fs))).slice(0, 300));
        else if (!v1Empty(fs)) bad.push(label + ': the v1 files were not emptied');
        rows++;
        void first;
      }
    }
    A.eq(bad, [], 'every refused read or write (' + rows + ' rows): no throw, a working store, and the retry ends with each item exactly once');
  }

  // ---- E. through REAL hubs: each migrated item delivered or replayed exactly once ----
  {
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const fs = seeded();
    const timers = fakeTimers();
    const store = boot(fs, timers);
    const sent = [], runs = [];
    const hubFor = (channel) => makeChannelHub({
      channel: channel, store: store,
      runOnce: async (o) => {
        const words = String(o.messages[o.messages.length - 1].content);
        runs.push(channel + ':' + words);
        o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'answer to ' + words }); o.emit('agent.run.end', { reason: 'done' });
      },
      send: async (chatId, text) => { sent.push(channel + '|' + chatId + ': ' + text); return { ok: true, messageId: 'm' + sent.length }; },
      secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => false,
      newId: (() => { let n = 0; return () => channel + '-run-' + (++n); })(), sleep: () => Promise.resolve(),
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
    });
    const tg = hubFor('telegram'), dc = hubFor('discord');
    tg.onStatus({ state: 'up' }); dc.onStatus({ state: 'up' });
    for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r));
    const tgSent = sent.filter(x => x.startsWith('telegram|4242: '));
    A.eq(tgSent.filter(x => /The late answer\./.test(x)).length, 1, 'the queued v1 reply lands once');
    A.ok(/^telegram\|4242: ⌛ delayed reply/.test(tgSent[0] || ''), 'first in its chat (it was the oldest), still saying it is delayed');
    A.eq(tgSent.filter(x => /The finished answer\./.test(x)).length, 1, 'the held answer lands once');
    A.eq(runs.filter(r => /first half|second half/.test(r)), [], 'and the run that earned it never runs again');
    A.eq(runs.filter(r => r === 'telegram:plain').length, 1, 'a receipt that never reached a run is replayed once');
    A.eq(runs.filter(r => /with tools/.test(r)), [], 'a receipt whose run had begun tool steps is never run again');
    A.eq(tgSent.filter(x => /StarNet restarted while it was working on "with tools"/.test(x) && /NOT run again/.test(x)).length, 1, 'it gets the interrupted notice, once');
    A.eq(runs.filter(r => /corrected/.test(r)), [], 'an edit of a message this process never saw is settled, never run');
    A.eq(sent.filter(x => /Discord, late\./.test(x)).length, 1, 'the Discord queued reply lands once, on Discord');
    A.eq(runs.filter(r => r === 'discord:from discord').length, 1, 'and the Discord receipt runs once, on Discord');
    A.eq([store.ledger.pending().length, store.ledger.deliveries().length], [0, 0], 'the ledger ends empty: every item had exactly one outcome');
    tg.close(); dc.close();
  }

  A.report('channels.ledger-migration.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
