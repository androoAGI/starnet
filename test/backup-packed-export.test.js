'use strict';
/* node test/backup-packed-export.test.js — a packed save never leaves the station by reference (save-history-by-reference, step S5).

   Save v7 lets a conversation NAME a run of rows the station's transcript holds instead of repeating them, which only means something
   beside that transcript. EXPORT (backup.js: the one portable file the page makes, built from the save in the browser cache) is meant
   to be opened on another browser or machine, so a packed history in it would be a reference to rows that station does not have: the
   turns would be gone where they were taken. This pins the rule (the plan's "inflates or refuses rather than shipping dangling refs"):

     · a save that names rows is exported WHOLE: every conversation read back from the station (the real route handler over the real
       transcript store), the page-only fields back on its rows, an undone turn not brought back — and the file opens on a station that
       holds none of those rows (a fresh page boots every row inline, nothing left to read);
     · a station that does not answer, or cannot return a row it cannot prove undone, STOPS the export (build rejects, exportAll says so
       and writes nothing) — never a file with a reference in it;
     · a save that names nothing is exported as the very text it was, with no request;
     · the in-memory save (a cache that cannot hold it) and the one-step undo of a cleared conversation go the same way.
   Both shipped trees run. SEAL_CONTROL_ROOT=<an older build's frontend/app> runs the same test against that build (the RED proof). */
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const { harnessApi } = require('./helpers/harness-api');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');

const ROOTS = process.env.SEAL_CONTROL_ROOT ? ['control'] : ['frontend/app', 'website/app/app'];
const clone = Rig.clone;

const mem = new Map();
global.localStorage = { get length() { return mem.size; }, key: i => Array.from(mem.keys())[i] || null, getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); }, clear: () => mem.clear() };

function station(streams) {
  const io = History.makeMemoryTranscriptIo({ clock: { now: () => 1 } }), live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  let ts = 1700000000000;
  for (let r = 0; r < 8; r++) for (const s of streams) io.appendDurable({ streamId: s, agentId: 'agent', role: r % 2 ? 'assistant' : 'user', kind: 'turn', taintKnown: true, ts: ++ts, content: 'row ' + r + ' of ' + s });
  const routes = Rig.routes({ store, live });
  return { io, store, routes, tp: Rig.transport(routes) };
}
// (the station appended its rows round robin over the streams: row r of stream i is row id r * streams + i + 1)
async function turnsOf(st, streamId, i, streams) {
  const res = { code: 0, body: null };
  const all = Array.from({ length: 8 }, (_, r) => r * streams + i + 1);
  await st.routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId, rowIds: all }] }) }, res);
  return res.body.streams[0].turns;
}
const record = (id, history, at) => ({ id, title: 'T ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1, lastActiveAt: at, lastReadAt: at });

async function scenarios(root) {
  const T = Rig.tree(root);
  const Backup = require(path.join(T.base, 'backup.js'));
  const run = async (name, fn) => { try { await fn(); A.ok(true, root + ': ' + name); } catch (e) { A.ok(false, root + ': ' + name + ' — ' + String(e && e.stack || e).split('\n').slice(0, 6).join(' | ')); } };
  const st = station(['ex1', 'ex2', 'ex3']);
  const original = { ex1: await turnsOf(st, 'ex1', 0, 3), ex2: await turnsOf(st, 'ex2', 1, 3), ex3: await turnsOf(st, 'ex3', 2, 3) };
  original.ex1[1].typedText = 'what I typed';                                          // page-only fields ride in the reference's residue
  original.ex1[2].attachments = [{ id: 'att1', name: 'photo.png' }];
  const legacy = { role: 'user', content: 'a row from before row ids', ts: 5 };           // never packed: nothing is matched by content
  const history = id => id === 'ex3' ? original.ex3.concat([legacy]) : original[id];
  const recs = () => ['ex1', 'ex2', 'ex3'].map((id, i) => record(id, clone(history(id)), 100 + i));
  // the page proves its rows (the idle sweep) and saves: the browser cache holds a packed save
  const prove = async () => {
    const p = Rig.page({ tree: T, tp: st.tp, init: { workstreams: recs(), activeId: 'ex1', generalId: 'ex1' } });
    let ticks = 0; while (await p.sweep() && ticks++ < 10);
    const doc = Object.assign({ schema: 'starnet.save', version: 7, updatedAt: 1760000000000, agent: { id: 'agent', name: 'NOVA' } }, p.W.serialize());
    return { p, doc };
  };
  const { p, doc } = await prove();
  const packedText = JSON.stringify(doc);
  assert.ok(doc.workstreams.filter(w => w.history.some(el => el && el.$ref)).length === 3, 'fixture: all three sessions name rows (' + packedText.length + ' bytes)');
  assert.ok(doc.workstreams.find(w => w.id === 'ex3').history.some(r => r.content === legacy.content && !r.$ref), 'fixture: the legacy row stays inline');
  const put = text => { mem.clear(); mem.set('starnet.save', text); mem.set('starnet.theme', 'green'); };
  const withStation = (tp, notebook) => { global.Harness = { api: harnessApi(tp.fetch), notebook: async () => notebook || [] }; };
  const exportedDoc = async () => JSON.parse((await Backup.build()).store['starnet.save']);
  let saved = [];
  global.U = { saveFile: async o => { saved.push(o); return { ok: true, file: o.name, line: 'saved' }; } };

  await run('a save that names rows is exported whole: every conversation by value, page-only fields back, no reference anywhere', async () => {
    put(packedText); withStation(st.tp); st.tp.calls.length = 0;
    const bundle = await Backup.build();
    const text = bundle.store['starnet.save'];
    assert.ok(!/"\$ref"/.test(text), 'no reference in the exported save');
    const out = JSON.parse(text);
    for (const id of ['ex1', 'ex2', 'ex3']) assert.deepEqual(out.workstreams.find(w => w.id === id).history, history(id), id + ': exactly the conversation the page holds');
    assert.deepEqual(Object.assign({}, out, { workstreams: 0 }), Object.assign({}, doc, { workstreams: 0 }), 'and nothing else in the save is touched');
    assert.equal(bundle.store['starnet.theme'], 'green', 'other settings ride along');
    assert.equal(Backup.validate(bundle), null, 'RESTORE BACKUP accepts it');
    assert.ok(st.tp.rowsCalls().length >= 3, 'the rows were read from the station (' + st.tp.rowsCalls().length + ' requests)');
  });

  await run('the file opens on a station that holds none of the rows: a fresh page boots every row, nothing left to read', async () => {
    put(packedText); withStation(st.tp);
    const bundle = await Backup.build();
    const empty = station(['other']), q = Rig.page({ tree: T, tp: empty.tp, init: JSON.parse(bundle.store['starnet.save']) });
    assert.deepEqual(q.W.pendingHydration(), [], 'no conversation boots packed');
    for (const id of ['ex1', 'ex2', 'ex3']) assert.deepEqual(q.W.get(id).history, history(id), id + ' boots with every row');
    assert.equal(empty.tp.rowsCalls().length, 0, 'and asks the station for nothing');
  });

  await run('a turn undone at the station since the save is not brought back by the export, as a reload would not bring it back', async () => {
    put(packedText); withStation(st.tp);
    const target = original.ex2[3];
    const r = st.store.retract({ streamId: 'ex2', rowIds: [target.rowId], reason: 'undo' });
    assert.equal(r.state, 'done');
    const out = await exportedDoc();
    assert.deepEqual(out.workstreams.find(w => w.id === 'ex2').history.map(x => x.rowId), original.ex2.filter(x => x.rowId !== target.rowId).map(x => x.rowId));
    assert.deepEqual(out.workstreams.find(w => w.id === 'ex1').history, history('ex1'), 'the others are whole');
  });

  await run('a station that does not answer stops the export: build rejects, exportAll says so and writes nothing', async () => {
    const quiet = Rig.transport(st.routes); quiet.down = true;
    put(packedText); withStation(quiet); saved = [];
    await assert.rejects(Backup.build(), e => e.code === 'EXPORT_PACKED_UNREADABLE' && e.sessions.length === 3);
    const r = await Backup.exportAll();
    assert.equal(r.ok, false); assert.match(r.line, /Export stopped/); assert.deepEqual(saved, [], 'no file was handed out');
    assert.equal(mem.get('starnet.save'), packedText, 'and the save in the cache is untouched');
  });

  await run('a row the station cannot return and cannot prove undone stops the export, naming how many conversations', async () => {
    const lost = clone(doc);
    const ex1 = lost.workstreams.find(w => w.id === 'ex1');
    ex1.history = Rig.clone(ex1.history).concat([{ $ref: '1jyqf' }]);   // a reference to a row no station holds
    put(JSON.stringify(lost)); withStation(st.tp); saved = [];
    await assert.rejects(Backup.build(), e => e.code === 'EXPORT_PACKED_UNREADABLE' && e.sessions.length === 1 && e.sessions[0] === 'ex1' && /1 saved conversation could not/.test(e.message));
    const r = await Backup.exportAll();
    assert.equal(r.ok, false); assert.deepEqual(saved, []);
  });

  await run('a save that names nothing is exported as the very text it was, without a request', async () => {
    const inline = JSON.stringify({ schema: 'starnet.save', version: 7, agent: { id: 'agent', name: 'NOVA' }, workstreams: recs(), activeId: 'ex1', generalId: 'ex1' });
    put(inline); withStation(st.tp); st.tp.calls.length = 0;
    const bundle = await Backup.build();
    assert.equal(bundle.store['starnet.save'], inline); assert.equal(st.tp.calls.length, 0);
    // (message text that merely MENTIONS a reference is not one)
    const talk = JSON.stringify({ schema: 'starnet.save', version: 7, agent: { id: 'agent', name: 'NOVA' }, workstreams: [record('ex1', [{ role: 'user', content: 'use {"$ref": "#/defs/a"} here', ts: 1 }], 1)] });
    put(talk); assert.equal((await Backup.build()).store['starnet.save'], talk); assert.equal(st.tp.calls.length, 0);
  });

  await run('the in-memory save (a cache that cannot hold it) is exported whole too; so is the undo of a cleared conversation, or left out if it cannot be read', async () => {
    withStation(st.tp);
    const checkpoint = { kind: 'clear', at: 5, activeId: 'ex1', count: 1, rows: [{ id: 'ex1', history: clone(doc.workstreams.find(w => w.id === 'ex1').history) }] };
    const withUndo = Object.assign({}, clone(doc), { sessionUndo: checkpoint });
    mem.clear(); global.CloudSave = { memorySave: () => clone(withUndo) };
    try {
      let out = JSON.parse((await Backup.build()).store['starnet.save']);
      assert.ok(!/"\$ref"/.test(JSON.stringify(out)), 'no reference anywhere in the memory save');
      assert.deepEqual(out.sessionUndo.rows[0].history, history('ex1'), 'the undo of a cleared conversation carries its rows');
      const quiet = Rig.transport(st.routes); quiet.down = true; withStation(quiet);
      mem.clear(); global.CloudSave = { memorySave: () => Object.assign(clone(doc), { workstreams: [], sessionUndo: checkpoint }) };
      out = JSON.parse((await Backup.build()).store['starnet.save']);
      assert.equal(out.sessionUndo, null, 'an undo whose rows cannot be read is left out: the export goes on without it');
      assert.ok(!/"\$ref"/.test(JSON.stringify(out)));
    } finally { delete global.CloudSave; }
  });
}

(async () => {
  for (const root of ROOTS) await scenarios(root);
  A.report('backup-packed-export (a packed save is exported by value or not at all; both shipped trees)');
})().catch(e => { console.error(e); process.exit(1); });
