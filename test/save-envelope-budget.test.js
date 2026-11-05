'use strict';
/* node test/save-envelope-budget.test.js — INVARIANT envelope-does-not-grow-with-history (save-history-by-reference, step S5).

   The page saved every session's whole history inside the one save envelope: 10,000 sessions of 3 turns were 14.5 MiB against the
   station's 16 MiB cap (12,000 of them were refused with a 413), and every turn added to the file every persist stringifies, posts and
   fsyncs. Save v7 names a run of rows the station's transcript holds instead of repeating it. This is the budget that buys:

     · the envelope of N sessions of sealed turns minus the envelope of the same N sessions with no turns is at most 48 bytes a session
       (N = 1,000 and 10,000: the history component of the 10,000-session save is under half a MiB), and a row added to a run costs a
       couple of bytes, not a row;
     · through production wiring: sessions built by Workstreams.init, the page's idle SEAL SWEEP (app.js sealSweepTick -> chat.js
       sealRows -> POST /api/transcript/rows -> the real route handler -> the REAL transcript store over an in-memory io) proves the rows,
       Workstreams.serialize() packs them, Save.envelope stamps them, and POST /api/save (the real handleSaveWrite over the real savestore,
       its real 16 MiB body reader) takes them;
     · 10,000 x 3 turns is under the 16 MiB cap, and 12,000 x 3 turns, which the old shape answered 413, is taken;
     · a fresh boot of that save hydrates every one of its 60,000 rows (count, order, content, page-only fields) through the page's idle
       hydration pass, none doubled, none missing.
   The absolute totals are printed and pinned at the measured value + 5 percent. SEAL_CONTROL_ROOT=<an older build's frontend/app> runs the
   same test against that build (the RED proof). */
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const Kit = require('./_save-restore-kit.js');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');

const ROOTS = process.env.SEAL_CONTROL_ROOT ? ['control'] : ['frontend/app', 'website/app/app'];
const MiB = 1048576;
const BASE_TS = 1700000000000;
const sid = i => 's' + String(i).padStart(5, '0');
const say = line => console.log('  ' + line);

/* the pins: the totals this fixture measured, +5 percent. The fixture is deterministic, so a drift is a change in the format or the fixture. */
const PIN = {
  1000: { empty: 607000, packed: 633400, inline: 2161300 },
  10000: { empty: 6088000, packed: 6355700, inline: 21757000 }
};

// the station's rows in memory, with an index on the row id so a 60,000-row transcript answers a by-id read as fast as the real one does
function indexedIo() {
  const io = History.makeMemoryTranscriptIo({ clock: { now: () => 1 } });
  const byId = new Map(), retracts = [], append = io.appendDurable;
  io.appendDurable = io.append = entry => { const row = append(entry); byId.set(row.rowId, row); if (row.kind === 'retract') retracts.push(row); return row; };
  io.readByIds = ids => {
    const out = new Map(), wanted = new Set(ids), retractions = new Map();
    for (const id of wanted) { const row = byId.get(id); if (row) out.set(id, Object.assign({}, row)); }
    for (const row of retracts) for (const id of row.targets || []) if (wanted.has(id) && (!retractions.has(id) || row.reason !== 'retry')) retractions.set(id, row.reason === 'retry' ? 'retry' : 'undo');
    Object.defineProperties(out, { proofComplete: { value: true }, retractions: { value: retractions } });
    return out;
  };
  return io;
}

function station(n, turns, TM) {
  const io = indexedIo(), live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  const rng = Rig.rng(11);
  let ts = BASE_TS;
  for (let i = 0; i < n; i++) for (let t = 0; t < turns; t++) {
    const turnId = TM.newTurnId(rng);
    io.appendDurable({ streamId: sid(i), agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: ++ts, turnId, directive: true, content: 'question ' + t + ' about ' + i + ' lorem ipsum dolor sit amet' });
    io.appendDurable({ streamId: sid(i), agentId: 'agent', role: 'assistant', kind: 'turn', taintKnown: true, ts: ++ts, turnId, sourceRunId: 'run_' + i + '_' + t, content: 'answer ' + t + ' lorem ipsum dolor sit amet consectetur adipiscing elit' });
  }
  const routes = Rig.routes({ store, live });
  return { io, store, routes, rows: n * turns * 2 };
}

// every stream's turns, read the way the page reads them: POST /api/transcript/rows through the route handler, 50 streams a request
async function readTurns(st, n, turns) {
  const out = new Map(), per = turns * 2, step = Math.max(1, Math.min(50, Math.floor(1000 / per)));   // (a request takes 50 streams and 1000 ids at most)
  for (let at = 0; at < n; at += step) {
    const streams = [];
    for (let i = at; i < Math.min(n, at + step); i++) streams.push({ streamId: sid(i), rowIds: Array.from({ length: per }, (_, k) => i * per + k + 1) });
    const res = { code: 0, body: null };
    await st.routes.handleTranscriptRows({ body: JSON.stringify({ streams }) }, res);
    assert.equal(res.code, 200, 'the fixture read answered');
    for (const one of res.body.streams) { assert.equal(one.turns.length, per, 'every row of ' + one.streamId + ' came back'); out.set(one.streamId, one.turns); }
  }
  return out;
}

// the page's records. residue: every hundredth session carries page-only fields on two of its rows (a typed text, an attachment)
function records(n, turnsMap, withTurns, residue) {
  return Array.from({ length: n }, (_, i) => {
    let history = [];
    if (withTurns) {
      history = turnsMap.get(sid(i)).map(t => Object.assign({}, t));
      if (residue && i % 100 === 7) { history[0].typedText = 'typed ' + i; history[2].attachments = [{ id: 'att-' + i, name: 'p' + i + '.png' }]; history[3].projectRoot = '/work/' + i; }
    }
    return { id: sid(i), title: 'Session ' + i, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: ['run_' + i], createdAt: BASE_TS + i, lastActiveAt: BASE_TS + 100000 + i, lastReadAt: BASE_TS + 100000 + i };
  });
}
const slice = recs => ({ workstreams: recs, activeId: recs[0].id, generalId: recs[0].id });
const envelope = (T, W) => T.Save.envelope(Object.assign({ agent: { id: 'agent', name: 'NOVA' }, _saveRevision: 0, _saveClient: 'tab1' }, W.serialize()));
const bytes = env => Buffer.byteLength(JSON.stringify(env));
const mib = b => (b / MiB).toFixed(2) + ' MiB';

async function scenario(root, heavy) {
  const T = Rig.tree(root);
  const label = root;
  const results = {};
  // (the website tree is the same files, byte for byte: test/website-app-sync.test.js holds it to that, so it runs the 1,000-session fixture and
  // the frontend runs the big ones too: building 60,000 rows twice only doubles this file's time)
  for (const [n, turns] of heavy ? [[1000, 3], [10000, 3]] : [[1000, 3]]) {
    const t0 = Date.now(), st = station(n, turns, T.TM), tp = Rig.transport(st.routes);
    const turnsMap = await readTurns(st, n, turns);
    const tBuilt = Date.now();
    // A. the same sessions with no turns at all
    const empty = envelope(T, (T.W.init(slice(records(n, turnsMap, false))), T.W));
    const emptyBytes = bytes(empty);
    // B. the old shape: every row inline (a page that has proved nothing packs nothing)
    const inlineRecs = records(n, turnsMap, true, true);
    const inlineBytes = bytes(envelope(T, (T.W.init(slice(inlineRecs)), T.W)));
    // C. the page proves the rows (the idle seal sweep through the station's routes) and saves
    const p = Rig.page({ tree: T, tp, init: slice(inlineRecs) });
    A.ok(p.hasSweep && p.hasSeal, label + ' N=' + n + ': app.js has the idle seal sweep and chat.js the seal read it asks through');
    const tSweep0 = Date.now();
    let ticks = 0;
    if (p.hasSweep) while (await p.sweep() && ticks++ < 5000);
    const tSweep = Date.now() - tSweep0;
    const sweepCalls = tp.rowsCalls().length;
    // what packing costs a persist: Workstreams.serialize() over every sealed row, recomputed from the rows themselves each time (nothing is cached:
    // an answer remembered by the history's identity, length and last row would keep the old one when a sealed row is changed in place)
    const serializeRuns = [];
    for (let k = 0; k < 3; k++) { const t = Date.now(); p.W.serialize(); serializeRuns.push(Date.now() - t); }
    const packedEnv = envelope(T, p.W), packedBytes = bytes(packedEnv);
    const perSession = (packedBytes - emptyBytes) / (n + 1);   // (General is the +1: it holds nothing)
    results[n] = { emptyBytes, inlineBytes, packedBytes, perSession, ticks, sweepCalls, tSweep, serializeMs: Math.min.apply(null, serializeRuns) };
    A.ok(results[n].serializeMs < 2000, label + ' N=' + n + ': packing ' + st.rows + ' sealed rows in a persist takes ' + serializeRuns.join('/') + ' ms (a stringify of the packed save is a fraction of that again)');
    say(label + ' N=' + n + ' x ' + turns + ' turns (' + st.rows + ' rows): empty ' + mib(emptyBytes) + ' · old shape (all inline) ' + mib(inlineBytes) + ' (' + Math.round((inlineBytes - emptyBytes) / n) + ' B of history a session) · packed ' + mib(packedBytes)
      + ' (' + perSession.toFixed(1) + ' B a session, history ' + mib(packedBytes - emptyBytes) + '; exact bytes: empty ' + emptyBytes + ', packed ' + packedBytes + ', inline ' + inlineBytes + ') · a persist packs it in ' + serializeRuns.join('/') + ' ms · sweep ' + ticks + ' ticks / ' + sweepCalls + ' requests / ' + tSweep + ' ms · built in ' + (tBuilt - t0) + ' ms');
    A.ok(perSession <= 48, label + ' N=' + n + ': the envelope grows by at most 48 B a session for 3 sealed turns (measured ' + perSession.toFixed(1) + ' B; the old shape grew ' + Math.round((inlineBytes - emptyBytes) / n) + ' B)');
    if (n === 10000) A.ok(packedBytes - emptyBytes <= 0.5 * MiB, label + ' N=10000: the history component is under half a MiB (' + mib(packedBytes - emptyBytes) + ')');
    A.ok(packedBytes <= PIN[n].packed && emptyBytes <= PIN[n].empty && inlineBytes <= PIN[n].inline, label + ' N=' + n + ': the totals hold their pins (empty ' + emptyBytes + '/' + PIN[n].empty + ', packed ' + packedBytes + '/' + PIN[n].packed + ', inline ' + inlineBytes + '/' + PIN[n].inline + ')');

    // POST /api/save: the real handler, the real savestore, the real 16 MiB reader
    const dir = Kit.workspace(), host = Kit.sidecar(dir, { realBody: true });
    const posted = await host.call(host.api.handleSaveWrite, { body: JSON.stringify(packedEnv) });
    const answer = await posted.json();
    A.ok(posted.ok && answer.ok, label + ' N=' + n + ': POST /api/save takes the packed save (' + posted.status + ')');
    if (posted.ok && answer.ok) {
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'agent.save.json'), 'utf8'));
      const doc = stored.doc || stored;
      A.eq(doc.version, 7, label + ' N=' + n + ': the station file is stamped v7');
      A.ok(doc.workstreams.filter(w => w.history.length && w.history.every(el => el && typeof el.$ref === 'string')).length >= n - 1, label + ' N=' + n + ': the sessions are saved as references (' + doc.workstreams.filter(w => w.history.some(el => el && el.$ref)).length + ' of ' + doc.workstreams.length + ')');
    }
    if (n === 10000) A.ok(packedBytes < 16 * MiB, label + ' N=10000: under the 16 MiB cap with ' + mib(16 * MiB - packedBytes) + ' to spare (room for ' + Math.floor(16 * MiB / (packedBytes / (n + 1))) + ' sessions of this size)');
    results[n].env = packedEnv; results[n].st = st; results[n].tp = tp; results[n].turnsMap = turnsMap; results[n].inlineRecs = inlineRecs;
    Kit.cleanup();
  }

  // a fresh boot of the 10,000-session save hydrates every row, through the page's idle hydration pass (production: HYDRATE_PER_TICK sessions a tick)
  if (heavy) {
    const r = results[10000], saved = JSON.parse(JSON.stringify(r.env));
    const tp = Rig.transport(r.st.routes), p = Rig.page({ tree: T, tp, init: saved });
    const packedSessions = T.W.pendingHydration().length;
    A.ok(packedSessions >= 10000, label + ' boot: ' + packedSessions + ' sessions boot packed (nothing is read yet: ' + tp.calls.length + ' requests)');
    const t0 = Date.now();
    let ticks = 0;
    while (await p.tick() && ticks++ < 5000);
    const ms = Date.now() - t0;
    A.eq(T.W.pendingHydration().length, 0, label + ' boot: every session is read back by the idle pass');
    let rows = 0, wrong = 0, doubled = 0, first = '';
    for (const rec of r.inlineRecs) {
      const ws = T.W.get(rec.id), want = rec.history;
      rows += ws.history.length;
      const keys = new Set(ws.history.map(x => x.rowId));
      if (keys.size !== ws.history.length) doubled++;
      if (JSON.stringify(ws.history) !== JSON.stringify(want)) { wrong++; if (!first) first = rec.id; }
    }
    say(label + ' boot: hydrated ' + rows + ' rows of ' + (T.W.all().length) + ' sessions in ' + ticks + ' ticks / ' + tp.rowsCalls().length + ' requests / ' + ms + ' ms');
    A.eq(rows, 10000 * 6, label + ' boot: all 60,000 rows are back');
    A.eq([wrong, doubled], [0, 0], label + ' boot: every session\'s rows equal what the page saved (count, order, content, residue), none doubled' + (first ? ' (first wrong: ' + first + ')' : ''));
    // a persist of the hydrated page packs again, to the same save
    const again = JSON.stringify(p.W.serialize().workstreams);
    A.eq(again === JSON.stringify(r.env.workstreams), true, label + ' boot: the hydrated page saves exactly the references it booted from');
  }

  // 12,000 sessions x 3 turns: the old shape was answered 413
  if (heavy) {
    const n = 12000, st = station(n, 3, T.TM), turnsMap = await readTurns(st, n, 3), recs = records(n, turnsMap, true, false);
    const W = T.W; W.init(slice(recs));
    const inlineEnv = envelope(T, W);
    for (let i = 0; i < n; i++) W.sealTurns(sid(i), turnsMap.get(sid(i)));
    const packedEnv = envelope(T, W);
    const dir = Kit.workspace(), host = Kit.sidecar(dir, { realBody: true });
    const oldAnswer = await host.call(host.api.handleSaveWrite, { body: JSON.stringify(inlineEnv) });
    const newAnswer = await host.call(host.api.handleSaveWrite, { body: JSON.stringify(Object.assign({}, packedEnv)) });
    say(label + ' N=12000 x 3 turns: old shape ' + mib(bytes(inlineEnv)) + ' -> HTTP ' + oldAnswer.status + ' · packed ' + mib(bytes(packedEnv)) + ' -> HTTP ' + newAnswer.status);
    A.eq(oldAnswer.status, 413, label + ' N=12000: (control) the old shape is over the cap and is refused');
    A.eq(newAnswer.status, 200, label + ' N=12000: the packed save is taken');
    Kit.cleanup();
  }

  // a row added to a run costs a couple of bytes, not a row: 1,000 sessions of 12 turns against the same sessions of 3
  {
    const n = 1000, st = station(n, 12, T.TM), turnsMap = await readTurns(st, n, 12), W = T.W;
    W.init(slice(records(n, turnsMap, true, false)));
    for (let i = 0; i < n; i++) W.sealTurns(sid(i), turnsMap.get(sid(i)));
    const long = bytes(envelope(T, W));
    const r3 = results[1000];
    const extra = (long - r3.packedBytes) / n, extraRows = 18;
    say(label + ' 1,000 sessions of 12 turns: ' + mib(long) + ' (' + extra.toFixed(1) + ' B a session more than 3 turns, for ' + extraRows + ' more rows; the old shape adds ' + Math.round(extraRows * (r3.inlineBytes - r3.emptyBytes) / n / 6) + ' B)');
    A.ok(extra <= extraRows * 2.5, label + ': 18 more rows in a session cost ' + extra.toFixed(1) + ' B (at most 2.5 B a row, not the ~' + Math.round((r3.inlineBytes - r3.emptyBytes) / n / 6) + ' B a row the old shape costs)');
  }
}

/* AN ATTACHMENT TURN (attachment-rows-and-taint, kinds round-trip). A turn that carried a file is three rows on the station: the directive
   (typed words, the file's references), one role-system 'attachment' row per file (sidecar/turn-attachment.js: a name, a path, a size and a hash,
   no bytes), and the answer. The page seals them like any row. This is the budget of a save of such sessions, and the round trip of every packed
   row, 'attachment' kind included, with the page-only fields (the residue) laid back over what the station returns. */
async function attachmentTurns(root) {
  const T = Rig.tree(root), label = root + ' attachment turns';
  const n = 300, turns = 3, rng = Rig.rng(23);
  const io = indexedIo(), live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  const ids = new Map();   // stream -> the row ids the station minted for it, in order
  let ts = BASE_TS;
  const add = (streamId, row) => { const r = io.appendDurable(Object.assign({ streamId, agentId: 'agent', ts: ++ts }, row)); ids.get(streamId).push(r.rowId); return r; };
  for (let i = 0; i < n; i++) {
    ids.set(sid(i), []);
    for (let t = 0; t < turns; t++) {
      const turnId = T.TM.newTurnId(rng), file = { id: 'att' + i + '_' + t, name: 'f' + t + '.txt', path: '.attachments/att' + i + '_' + t + '.txt', mediaType: 'text/plain', kind: 'file' };
      add(sid(i), { role: 'user', kind: 'turn', taintKnown: true, turnId, directive: true, content: 'question ' + t + ' about ' + i + ' lorem ipsum', attachments: [file] });
      add(sid(i), { role: 'system', kind: 'attachment', turnId, content: '[attached: ' + file.name + ']', taint: 'user attachment', attachment: Object.assign({ size: 40 + t, sha256: 'ab'.repeat(32) }, file) });
      add(sid(i), { role: 'assistant', kind: 'turn', taintKnown: true, turnId, sourceRunId: 'run_' + i + '_' + t, taint: 'user attachment', content: 'answer ' + t + ' lorem ipsum dolor sit amet' });
    }
  }
  const routes = Rig.routes({ store, live }), tp = Rig.transport(routes), per = turns * 3;
  const read = new Map();
  for (let i = 0; i < n; i++) {
    const res = { code: 0, body: null };
    await routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId: sid(i), rowIds: ids.get(sid(i)) }] }) }, res);
    assert.equal(res.code, 200, 'the fixture read answered');
    read.set(sid(i), res.body.streams[0].turns);
  }
  const kinds = new Set(); let rows = 0;
  for (const turnsOf of read.values()) for (const r of turnsOf) { kinds.add(r.kind); rows++; }
  const held = Array.from(ids.keys()).reduce((c, id) => c + [...io.readByIds(ids.get(id)).values()].filter(r => r.kind === 'attachment').length, 0);
  A.eq(held, n * turns, label + ': the station holds one attachment row per file (' + held + ')');
  A.eq([...kinds], ['turn'], label + ': the rows route hands the page the turns only: an attachment row is provenance, never a surface of the page (' + rows + ' rows of ' + n * per + ')');
  const withResidue = withTurns => Array.from({ length: n }, (_, i) => {
    const history = withTurns ? read.get(sid(i)).map(t => Object.assign({}, t)) : [];
    if (withTurns && i % 10 === 3) { history[0].typedText = 'typed ' + i; history[1].stopNote = 'note ' + i; history[2].projectRoot = '/work/' + i; history[0].attachments = history[0].attachments.concat([{ id: 'extra' + i, name: 'x.png' }]); }
    return { id: sid(i), title: 'Session ' + i, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: ['run_' + i], createdAt: BASE_TS + i, lastActiveAt: BASE_TS + 100000 + i, lastReadAt: BASE_TS + 100000 + i };
  });
  const emptyBytes = bytes(envelope(T, (T.W.init(slice(withResidue(false))), T.W)));
  const recs = withResidue(true);
  const inlineBytes = bytes(envelope(T, (T.W.init(slice(recs)), T.W)));
  const p = Rig.page({ tree: T, tp, init: slice(recs) });
  let ticks = 0;
  if (p.hasSweep) while (await p.sweep() && ticks++ < 5000);
  const packedEnv = envelope(T, p.W), packedBytes = bytes(packedEnv), perSession = (packedBytes - emptyBytes) / (n + 1);
  say(label + ' x ' + n + ' sessions of ' + turns + ' turns (' + rows + ' rows): empty ' + emptyBytes + ' B · all inline ' + inlineBytes + ' B · packed ' + packedBytes + ' B (' + perSession.toFixed(1) + ' B a session)');
  A.ok(perSession <= 80, label + ': the envelope grows by at most 80 B a session for ' + per + ' sealed rows of 3 attachment turns, not by the rows (the old shape grew ' + Math.round((inlineBytes - emptyBytes) / n) + ' B)');
  const doc = JSON.parse(JSON.stringify(packedEnv)), packed = doc.workstreams.filter(w => w.history.length && w.history.some(el => el && typeof el.$ref === 'string')).length;
  A.ok(packed >= n * 0.9, label + ': the sessions are saved as references (' + packed + ' of ' + n + ')');
  // the round trip: a fresh boot of that save reads every packed row back, the attachment kind included, with its residue laid over it
  const boot = Rig.page({ tree: T, tp: Rig.transport(routes), init: doc });
  ticks = 0;
  while (await boot.tick() && ticks++ < 5000);
  A.eq(T.W.pendingHydration().length, 0, label + ' boot: every session is read back by the idle pass');
  let wrong = 0, doubled = 0, first = '', attachRows = 0, residue = 0;
  for (const rec of recs) {
    const ws = T.W.get(rec.id);
    if (new Set(ws.history.map(x => x.rowId)).size !== ws.history.length) doubled++;
    if (JSON.stringify(ws.history) !== JSON.stringify(rec.history)) { wrong++; if (!first) first = rec.id; }
    attachRows += ws.history.filter(x => x.kind === 'attachment').length;
    residue += ws.history.filter(x => x.typedText || x.stopNote || x.projectRoot || (x.attachments || []).some(a => a.id && a.id.startsWith('extra'))).length;
    void per;
  }
  A.eq([wrong, doubled], [0, 0], label + ' boot: every session\'s rows equal what the page saved (count, order, content, residue), none doubled' + (first ? ' (first wrong: ' + first + ')' : ''));
  A.eq(attachRows, 0, label + ' boot: no attachment row reaches the page, packed or not');
  A.eq(T.W.get(sid(3)).history.filter(x => x.role === 'user').map(x => (x.attachments || []).length), [2, 1, 1], label + ' boot: a directive row comes back with its references, and the page-only extra over them');
  A.ok(residue >= (n / 10) * 3, label + ' boot: the page-only fields came back over the station\'s rows (' + residue + ')');
}


/* THE ROW KINDS OF TURN IDENTITY (commit 10, kinds round-trip). A turn that made a file, took a steering note and was followed by a routine's
   return leaves four kinds on the station beside the dialogue: a file row (kind deliverable) and a steering note (kind steer), both role-system
   rows the page shows (the matrix displays them) and keeps inline, and a delivery row (kind delivery), an assistant row the page seals and
   packs like any reply. Each is read back by the rows route as the page's row; the round trip below is the save of such sessions, restored by a
   fresh boot with the page-only fields (the residue) laid over the station's rows. */
async function turnIdentityKinds(root) {
  const T = Rig.tree(root), label = root + ' row kinds';
  const n = 120, turns = 3, rng = Rig.rng(29);
  const io = indexedIo(), live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  const ids = new Map();
  let ts = BASE_TS, serial = 0;
  const add = (streamId, row) => { const r = io.appendDurable(Object.assign({ streamId, agentId: 'agent', ts: ++ts }, row)); ids.get(streamId).push(r.rowId); return r; };
  for (let i = 0; i < n; i++) {
    ids.set(sid(i), []);
    for (let t = 0; t < turns; t++) {
      const turnId = T.TM.newTurnId(rng), runId = 'run_' + i + '_' + t, back = 'ret_' + i + '_' + t, name = 'r' + t + '.md';
      add(sid(i), { role: 'user', kind: 'turn', taintKnown: true, turnId, directive: true, sourceRunId: runId, content: 'question ' + t + ' about ' + i + ' lorem ipsum' });
      add(sid(i), { role: 'system', kind: 'deliverable', turnId, sourceRunId: runId, content: 'saved ' + name, deliverable: { path: 'out/' + name, media: 'file', workspace: 'agent', root: '', name, artifactId: 'file_out_' + name } });
      add(sid(i), { role: 'system', kind: 'steer', taintKnown: true, turnId, sourceRunId: runId, noteId: 'sn' + (++serial), content: 'make it shorter ' + t });
      add(sid(i), { role: 'assistant', kind: 'turn', taintKnown: true, turnId, sourceRunId: runId, content: 'answer ' + t + ' lorem ipsum dolor sit amet' });
      add(sid(i), { role: 'assistant', kind: 'delivery', turnId: 'r' + back, sourceRunId: back, content: '✦ Property routine\n\nRoutine result ' + t + ' for ' + i });
    }
  }
  const routes = Rig.routes({ store, live }), tp = Rig.transport(routes);
  const read = new Map();
  for (let i = 0; i < n; i++) {
    const res = { code: 0, body: null };
    await routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId: sid(i), rowIds: ids.get(sid(i)) }] }) }, res);
    assert.equal(res.code, 200, 'the fixture read answered');
    read.set(sid(i), res.body.streams[0].turns);
  }
  const kinds = {};
  for (const turnsOf of read.values()) for (const r of turnsOf) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  A.eq(kinds, { turn: n * turns * 2, deliverable: n * turns, steer: n * turns, delivery: n * turns }, label + ': the rows route hands the page every kind the matrix displays, once');
  const recs = Array.from({ length: n }, (_, i) => {
    const history = read.get(sid(i)).map(t => Object.assign({}, t));
    if (i % 10 === 3) for (const r of history) if (r.kind === 'delivery' || r.kind === 'turn') r.stopNote = 'note ' + i + ' ' + r.rowId;   // page-only fields (residue) on packed rows
    return { id: sid(i), title: 'Session ' + i, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: ['run_' + i], createdAt: BASE_TS + i, lastActiveAt: BASE_TS + 100000 + i, lastReadAt: BASE_TS + 100000 + i };
  });
  const p = Rig.page({ tree: T, tp, init: slice(recs) });
  let ticks = 0;
  if (p.hasSweep) while (await p.sweep() && ticks++ < 5000);
  const doc = JSON.parse(JSON.stringify(envelope(T, p.W)));
  let packedDelivery = 0, packedSystem = 0, inlineSystem = 0, inlineDelivery = 0;
  for (const w of doc.workstreams) {
    const packed = new Set(T.HR.idsOf(w.history));
    const rec = recs.find(r => r.id === w.id);
    if (!rec) continue;
    for (const r of rec.history) {
      if (r.role === 'system') { if (packed.has(r.rowId)) packedSystem++; else inlineSystem++; }
      else if (r.kind === 'delivery') { if (packed.has(r.rowId)) packedDelivery++; else inlineDelivery++; }
    }
  }
  A.eq(packedSystem, 0, label + ': a file row and a steering note are system rows: none is named by a reference (' + inlineSystem + ' kept inline)');
  A.ok(packedDelivery >= n * turns * 0.9, label + ': the routine returns are saved as references (' + packedDelivery + ' packed, ' + inlineDelivery + ' inline of ' + n * turns + ')');
  say(label + ' x ' + n + ' sessions of ' + turns + ' turns (' + n * turns * 5 + ' rows): ' + packedDelivery + ' routine returns packed, ' + inlineSystem + ' system rows kept inline');
  const boot = Rig.page({ tree: T, tp: Rig.transport(routes), init: doc });
  ticks = 0;
  while (await boot.tick() && ticks++ < 5000);
  A.eq(T.W.pendingHydration().length, 0, label + ' boot: every session is read back by the idle pass');
  let wrong = 0, doubled = 0, first = '', residue = 0, back = { deliverable: 0, steer: 0, delivery: 0 };
  for (const rec of recs) {
    const ws = T.W.get(rec.id);
    if (new Set(ws.history.map(x => x.rowId)).size !== ws.history.length) doubled++;
    if (JSON.stringify(ws.history) !== JSON.stringify(rec.history)) { wrong++; if (!first) first = rec.id; }
    for (const x of ws.history) { if (back[x.kind] !== undefined) back[x.kind]++; if (x.kind === 'delivery' && x.stopNote) residue++; }
  }
  A.eq([wrong, doubled], [0, 0], label + ' boot: every session\'s rows equal what the page saved (count, order, content, residue), none doubled' + (first ? ' (first wrong: ' + first + ')' : ''));
  A.eq(back, { deliverable: n * turns, steer: n * turns, delivery: n * turns }, label + ' boot: every file row, steering note and routine return came back');
  A.ok(residue >= (n / 10) * turns, label + ' boot: the page-only field came back over the routine returns packed in the save (' + residue + ')');
}

(async () => {
  const t0 = Date.now();
  for (const [i, root] of ROOTS.entries()) {
    try { await scenario(root, i === 0); await attachmentTurns(root); await turnIdentityKinds(root); } catch (e) { A.ok(false, root + ': the budget test threw — ' + String(e && e.stack || e).split('\n').slice(0, 6).join(' | ')); }
  }
  const ms = Date.now() - t0;
  say('whole test: ' + ms + ' ms (' + (ms >= 40000 ? 'slow.list' : 'fast.list') + ')');
  A.report('save-envelope-budget (the save does not grow with history; every row restores)');
})().catch(e => { console.error(e); process.exit(1); });
