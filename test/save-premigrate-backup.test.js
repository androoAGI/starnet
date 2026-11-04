/* node test/save-premigrate-backup.test.js — the browser's pre-migration copy of the save follows the Commander's deletes and does not live forever.

   save.js keeps the raw save from before a migration (starnet.save.pre-migrate.backup) so a bad migration can be recovered by hand. That
   copy is every conversation the station held at the moment of the upgrade, written once. The v7 bump (history by reference) writes one
   for every install that has none, so three things have to hold or a conversation the Commander deleted outlives the delete in this
   browser, and the copy outlives everything else:
     · it is KEPT as the way back: made once from the raw bytes, stamped with the day it was made, never overwritten by a later load;
     · a delete is FOLLOWED: the persist that records a conversation's deletion (the save's forgetIds, Workstreams.del({forget:true}))
       cuts the conversation out of the copy: its record, its ~restored copies, the worker threads that were its own and its rows in the
       undo checkpoint. What is not forgotten stays, so the way back still works for everything else. A copy that cannot be read, or
       cannot be written back, cannot be shown to be free of the conversation, so it goes whole;
     · it EXPIRES: 30 days after it was made (a copy an older build made, with no stamp, 30 days after it is first seen; a stamp from a
       wrong clock is pulled back to now), and Save.clear() takes it with the save. */
'use strict';
const A = require('./_assert.js');

const BACKUP = 'starnet.save.pre-migrate.backup', STAMP = BACKUP + '.at', KEY = 'starnet.save';
const DAY = 24 * 60 * 60 * 1000, T0 = 1700000000000;

// a browser cache that counts reads and writes of the backup, and a clock the test moves
let mem = {}, reads = 0, writes = 0, clock = T0;
global.localStorage = {
  getItem: k => { if (k === BACKUP) reads++; return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem: (k, v) => { if (k === BACKUP) writes++; mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }, clear: () => { mem = {}; }, key: i => Object.keys(mem)[i] || null, get length() { return Object.keys(mem).length; }
};
const realNow = Date.now;
Date.now = () => clock;

const SAVE_PATH = require.resolve('../frontend/app/save.js');
const freshSave = () => { delete require.cache[SAVE_PATH]; return require(SAVE_PATH); };   // the module remembers what it has cut out of the copy
const CURRENT = freshSave().CURRENT;   // the copy is made by whatever migration the current build runs: a save one format behind
const Workstreams = require('../frontend/app/workstreams.js');

const row = (role, content) => ({ role, content });
const SECRET = 'my secret tax numbers';
const sessions = () => [
  { id: 'general', title: null, history: [row('user', 'hello')] },
  { id: 'A', title: 'Taxes', history: [row('user', SECRET), row('assistant', 'noted')] },
  { id: 'A~restored', title: 'Taxes (restored copy)', history: [row('user', SECRET)] },
  { id: 'A~restored2', title: 'Taxes (restored copy 2)', history: [row('user', SECRET)] },
  { id: 'W', title: 'worker', worker: true, parentStreamId: 'A', history: [row('assistant', 'the worker quoting ' + SECRET)] },
  { id: 'AB', title: 'Not A', history: [row('user', 'a different conversation whose id starts with A')] },
  { id: 'B', title: 'Garden', history: [row('user', 'tomatoes')] },
  { id: 'C', title: 'Trip', history: [row('user', 'lisbon in may')] }
];
const doc = (version, over) => Object.assign({ schema: 'starnet.save', version, updatedAt: T0, agent: { id: 'agent', name: 'NOVA' }, workstreams: sessions(),
  sessionUndo: { kind: 'clear', at: T0, activeId: 'A', rows: [{ id: 'A', history: [row('user', SECRET)] }, { id: 'C', history: [row('user', 'lisbon in may')] }] } }, over || {});
const put = (raw, extra) => { mem = { [KEY]: raw }; Object.assign(mem, extra || {}); reads = 0; writes = 0; };
const idsIn = raw => { try { return JSON.parse(raw).workstreams.map(w => w.id); } catch (_) { return null; } };

(() => {
  // ================================================================================================================
  // 1. KEPT: made once from the raw bytes, stamped
  // ================================================================================================================
  const rawOld = JSON.stringify(doc(CURRENT - 1));
  clock = T0; put(rawOld);
  let Save = freshSave();
  A.eq(Save.loadStatus().status, 'ok', 'a save one format behind loads');
  A.eq(mem[BACKUP], rawOld, 'the raw bytes from before the migration are kept as the recovery copy');
  A.eq(mem[STAMP], String(T0), 'stamped with the time it was made');
  clock = T0 + DAY;
  mem[KEY] = JSON.stringify(doc(CURRENT - 1, { updatedAt: 2 }));
  Save.loadStatus();
  A.eq(mem[BACKUP], rawOld, 'a later load leaves the first copy alone: it is made once');
  A.eq(mem[STAMP], String(T0), '...and the day it was made does not move');
  // a save a newer build wrote is refused untouched: no copy, no stamp
  clock = T0; put(JSON.stringify(doc(CURRENT + 1)));
  Save = freshSave();
  A.eq(Save.loadStatus().status, 'future', 'a save from a newer build is refused');
  A.eq([mem[BACKUP], mem[STAMP]], [undefined, undefined], '...and no copy of it is made');

  // ================================================================================================================
  // 2. FOLLOWED: the persist that records a delete cuts the conversation out of the copy
  // ================================================================================================================
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  A.ok(mem[BACKUP].includes(SECRET), 'fixture: the copy holds the conversation');
  reads = 0; writes = 0;
  Save.write({ agent: { id: 'agent', name: 'NOVA' }, workstreams: [], deletedIds: [], forgetIds: [] });
  A.eq([reads, writes], [0, 0], 'a persist that forgets nothing does not touch the copy');
  Save.write({ agent: { id: 'agent', name: 'NOVA' }, workstreams: [], forgetIds: ['A'] });
  const cut = mem[BACKUP];
  A.eq(idsIn(cut), ['general', 'AB', 'B', 'C'], 'the conversation, its restored copies and its worker thread are cut out of the copy; the others stay');
  A.ok(!cut.includes(SECRET), 'no word the deleted conversation held survives in the copy (records, restored copies, the worker thread)');
  A.eq(JSON.parse(cut).sessionUndo.rows.map(r => r.id), ['C'], 'the deleted conversation\'s rows in the undo checkpoint go too; the others stay');
  A.eq(JSON.parse(cut).agent, { id: 'agent', name: 'NOVA' }, 'the rest of the copy is as it was');
  A.eq(mem[STAMP], String(T0), 'cutting a conversation out does not make the copy younger');
  reads = 0; writes = 0;
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['A'] });
  A.eq([reads, writes], [0, 0], 'the same delete in a later persist costs no read of the copy');
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['A', 'not-in-the-copy'] });
  A.eq(writes, 0, 'a delete the copy does not hold writes nothing');
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['', 5, null, 'B'] });
  A.eq(idsIn(mem[BACKUP]), ['general', 'AB', 'C'], 'junk in the list is ignored; the real id is cut');
  A.eq(JSON.parse(mem[BACKUP]).sessionUndo.rows.map(r => r.id), ['C'], '...and the undo checkpoint is as it was');
  // the last row of the checkpoint goes: the checkpoint goes with it
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['C'] });
  A.ok(!('sessionUndo' in JSON.parse(mem[BACKUP])), 'a checkpoint left with no rows is dropped');

  // the production source of forgetIds: Workstreams.del(id, { forget: true }) -> serialize() -> Save.write
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  Workstreams.init({ workstreams: sessions(), activeId: 'general', generalId: 'general' });
  Workstreams.del('A', { forget: true });
  Save.write(Object.assign({ agent: { id: 'agent', name: 'NOVA' } }, Workstreams.serialize()));
  A.eq(idsIn(mem[BACKUP]), ['general', 'AB', 'B', 'C'], 'a Delete in the rail (Workstreams.del forget) cuts the conversation, its restored copies and its workers out of the copy');
  A.ok(!mem[BACKUP].includes(SECRET), '...so nothing it said is left');
  // a row hidden as a side effect (not forgotten) is not a privacy delete: it stays
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  Workstreams.init({ workstreams: sessions(), activeId: 'general', generalId: 'general' });
  Workstreams.del('B');
  Save.write(Object.assign({ agent: { id: 'agent', name: 'NOVA' } }, Workstreams.serialize()));
  A.eq(idsIn(mem[BACKUP]), idsIn(rawOld), 'a row removed without forgetting (DELETE AGENT, a task card) is not a delete of the conversation: the copy keeps it');

  // a copy that cannot be read cannot be shown to be free of the conversation: it goes whole
  clock = T0; put(rawOld, { [BACKUP]: '{"schema":"starnet.save","workstreams":[{"id":"A","history":[{"content":"' + SECRET, [STAMP]: String(T0) });
  Save = freshSave();
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['A'] });
  A.eq([mem[BACKUP], mem[STAMP]], [undefined, undefined], 'an unreadable copy is removed whole, with its stamp');
  clock = T0; put(rawOld, { [BACKUP]: '[1,2,3]', [STAMP]: String(T0) });
  Save = freshSave();
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['A'] });
  A.eq([mem[BACKUP], mem[STAMP]], [undefined, undefined], 'so is a copy that is not a save');
  // ...and one that cannot be written back
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  const realSet = global.localStorage.setItem;
  global.localStorage.setItem = (k, v) => { if (k === BACKUP) throw new Error('QuotaExceededError'); return realSet(k, v); };
  Save.write({ agent: { id: 'agent' }, workstreams: [], forgetIds: ['A'] });
  global.localStorage.setItem = realSet;
  A.eq([mem[BACKUP], mem[STAMP]], [undefined, undefined], 'a copy the cache will not take back after the cut is removed whole, not kept with the conversation in it');

  // ================================================================================================================
  // 3. EXPIRES: 30 days after it was made
  // ================================================================================================================
  const rawNow = JSON.stringify(doc(CURRENT));
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  mem[KEY] = rawNow;                                           // the first persist after the migration rewrote the save at the current format
  clock = T0 + 30 * DAY - 1;
  A.eq(Save.loadStatus().status, 'ok', 'the save loads');
  A.eq(mem[BACKUP], rawOld, 'a copy one millisecond short of 30 days is kept');
  clock = T0 + 30 * DAY;
  A.eq(Save.loadStatus().status, 'ok', 'the save loads');
  A.eq([mem[BACKUP], mem[STAMP]], [undefined, undefined], 'a copy 30 days old is removed, with its stamp');
  // a copy an older build made has no stamp: the 30 days start when it is first seen, nothing is removed the moment it is found
  clock = T0; put(rawNow, { [BACKUP]: rawOld });
  Save = freshSave();
  Save.loadStatus();
  A.eq([mem[BACKUP], mem[STAMP]], [rawOld, String(T0)], 'an unstamped copy is kept and stamped the day it is first seen');
  clock = T0 + 29 * DAY; Save.loadStatus();
  A.eq(mem[BACKUP], rawOld, '...and kept for the 30 days');
  clock = T0 + 30 * DAY; Save.loadStatus();
  A.eq(mem[BACKUP], undefined, '...then removed');
  // a stamp from a wrong clock does not keep the copy for ever
  clock = T0; put(rawNow, { [BACKUP]: rawOld, [STAMP]: String(T0 + 400 * DAY) });
  Save = freshSave();
  Save.loadStatus();
  A.eq([mem[BACKUP], mem[STAMP]], [rawOld, String(T0)], 'a stamp from the future is pulled back to now');
  clock = T0 + 30 * DAY; Save.loadStatus();
  A.eq(mem[BACKUP], undefined, '...and the copy goes 30 days on');
  // a save still one format behind after the copy expired is migrated again: it gets a fresh copy of what is still unmigrated
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  clock = T0 + 31 * DAY; Save.loadStatus();
  A.eq([mem[BACKUP], mem[STAMP]], [rawOld, String(T0 + 31 * DAY)], 'a save that never left the old format is copied afresh, stamped afresh');

  // ================================================================================================================
  // 4. CLEARED: with the save
  // ================================================================================================================
  clock = T0; put(rawOld);
  Save = freshSave();
  Save.loadStatus();
  Save.clear();
  A.eq([mem[KEY], mem[BACKUP], mem[STAMP]], [undefined, undefined, undefined], 'Save.clear() removes the save, the copy and its stamp');

  Date.now = realNow;
  A.report('save-premigrate-backup');
})();
