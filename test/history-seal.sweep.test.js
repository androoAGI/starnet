'use strict';
/* node test/history-seal.sweep.test.js — the page proves what it saved inline (save-history-by-reference, step S5).

   A save names a row instead of repeating it only for a row this page has PROVED the station holds, and a page that has just read a save has
   proved nothing: its seals are page memory. Two things prove rows without anyone opening the conversation, and this pins their behavior:

     THE SEAL SWEEP (app.js sealSweepTick -> chat.js sealRows -> POST /api/transcript/rows): while the page is idle it asks the station for the
       inline rows of the sessions it holds, 1,000 ids across 50 sessions at most a request, the most recently active first; it keeps no cursor, changes no
       conversation, asks nothing while any run is live, pauses when the station is silent, gives up on an id the station does not answer and on a request it
       keeps refusing (never a loop), never asks about a row with no row id or a session the route cannot take, and saves once it has proved something.
     THE SEAL PASS (chat.js sealSoon / sealPass / sealLeft): 2 s after a run ends (a burst is one read) the open-time read runs again on the conversation the
       run left unproven — never one a run is live in, never one that is still packed, and never one the Commander is looking at, which is read when they leave
       it — with no repaint, so the run's own rows are named, not repeated, in the very next save.
   Production wiring: the real transcript store behind the real route handlers, the real Harness.api, the real Workstreams / HistoryRef / TurnMerge, chat.js and
   app.js lifted by name (test/helpers/seal-rig.js). Both shipped trees run. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const { TurnFixture } = require('./helpers/turn-fixture.js');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');

const ROOTS = process.env.SEAL_CONTROL_ROOT ? ['control'] : ['frontend/app', 'website/app/app'];
const clone = Rig.clone;
const sid = i => 'q' + String(i).padStart(3, '0');

function memoryStation(streams, rowsPer) {
  const io = History.makeMemoryTranscriptIo({ clock: { now: () => 1 } }), live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  let ts = 1700000000000;
  for (let r = 0; r < rowsPer; r++) for (const s of streams) io.appendDurable({ streamId: s, agentId: 'agent', role: r % 2 ? 'assistant' : 'user', kind: 'turn', taintKnown: true, ts: ++ts, content: 'row ' + r + ' of ' + s });
  const routes = Rig.routes({ store, live });
  return { io, store, routes, tp: Rig.transport(routes) };
}
const record = (id, history, at) => ({ id, title: 'T ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1, lastActiveAt: at, lastReadAt: at });
const slice = recs => ({ workstreams: recs, activeId: recs[0].id, generalId: recs[0].id });

async function sweepScenarios(root) {
  const T = Rig.tree(root);
  const run = async (name, fn) => { try { await fn(); A.ok(true, root + ': ' + name); } catch (e) { A.ok(false, root + ': ' + name + ' — ' + String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')); } };
  const streams = Array.from({ length: 60 }, (_, i) => sid(i));
  const st = memoryStation(streams, 4);
  const turns = new Map();
  // (the station appended its rows round robin: row r of stream i is row id r * streams + i + 1)
  streams.forEach((s, i) => { const res = { code: 0, body: null }; return st.routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId: s, rowIds: [0, 1, 2, 3].map(r => r * streams.length + i + 1) }] }) }, res).then(() => turns.set(s, res.body.streams[0].turns)); });
  await Rig.flush();
  assert.ok(turns.get(streams[0]).length === 4, 'fixture: four rows a stream');
  const recs = () => streams.map((s, i) => record(s, clone(turns.get(s)), 1000 + i));

  await run('the sweep proves the inline rows of every session, a request at a time (<= 50 sessions, <= 1000 ids), the most recently active first, and changes no conversation', async () => {
    st.tp.calls.length = 0;
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(recs()) });
    assert.ok(p.hasSweep && p.hasSeal, 'app.js has the sweep and chat.js the read it asks through');
    const before = JSON.stringify(p.W.all().map(w => w.history));
    assert.equal(p.W.serialize().workstreams.every(w => w.history.every(r => !r.$ref)), true, 'before the sweep a save repeats every row');
    assert.equal(await p.sweep(), true);
    const first = st.tp.rowsCalls()[0].body.streams;
    assert.equal(first.length, 50, 'the first request names 50 sessions');
    assert.deepEqual(first.slice(0, 3).map(s => s.streamId), [sid(59), sid(58), sid(57)], 'the most recently active first');
    assert.ok(first.every(s => s.rowIds.length === 4) && first.reduce((n, s) => n + s.rowIds.length, 0) <= 1000, 'ids ride in the request (' + first.reduce((n, s) => n + s.rowIds.length, 0) + ')');
    assert.equal(p.persistCount(), 1, 'the first tick that proves something saves, so the shorter save lands');
    assert.equal(await p.sweep(), true);
    assert.equal(st.tp.rowsCalls().length, 2); assert.equal(await p.sweep(), false, 'nothing is left to ask');
    assert.equal(JSON.stringify(p.W.all().map(w => w.history)), before, 'no conversation was changed');
    assert.ok(p.W.serialize().workstreams.filter(w => w.history.length).every(w => w.history.length === 1 && w.history[0].$ref), 'every session is now saved as one reference');
    assert.ok(p.persistCount() >= 2, 'and it saved once it was done');
  });

  await run('it asks nothing while any run is live, pauses when the station is silent, and a request the station refuses is not repeated for ever', async () => {
    st.tp.calls.length = 0;
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(recs()) });
    p.busy.add(sid(1));
    assert.equal(await p.sweep(), false); assert.equal(st.tp.calls.length, 0, 'a run is live: not a request');
    p.busy.clear();
    st.tp.down = true;
    assert.equal(await p.sweep(), false, 'a silent station proves nothing'); const asked = st.tp.calls.length;
    st.tp.down = false;
    assert.equal(await p.sweep(), false, 'and the sweep waits before it asks again'); assert.equal(st.tp.calls.length, asked);
    // a station that answers 4xx to every request: three asks, then the rows are left alone (no 1.5 s loop of refusals)
    const q = Rig.page({ tree: T, tp: st.tp, init: slice(recs()) });
    st.tp.status = 403; st.tp.calls.length = 0;
    try {
      for (let ticks = 0; ticks < 20; ticks++) await q.sweep();   // (the idle loop beats every 10 s after a tick that proved nothing; here it beats as fast as it can)
      assert.equal(st.tp.rowsCalls().length, 6, 'a refused request is asked three times, for each of the two batches, and not for ever (' + st.tp.rowsCalls().length + ' requests)');
      assert.equal(q.W.sealCandidates({ any: true }).length, 0, 'and the rows are left inline');
    } finally { st.tp.status = 0; }
  });

  await run('a row the station does not hold is asked a few times and left inline; a row with no row id, a session the route cannot take, an unhydrated or group session are never asked', async () => {
    st.tp.calls.length = 0;
    const lost = { streamId: sid(0), agentId: 'agent', role: 'assistant', kind: 'turn', taintKnown: true, ts: 5, content: 'a reply the station never kept', rowId: 987654 };
    const rs = recs().slice(0, 3);
    rs[0].history = rs[0].history.concat([lost, { role: 'user', content: 'legacy row, no id', ts: 6 }]);
    rs.push(record('weird:id', clone(turns.get(streams[5])).map(t => Object.assign({}, t, { streamId: 'weird:id' })), 2000));   // (its rows claim the stream: one id the route refuses would refuse the whole request)
    rs.push(record('grp', clone(turns.get(streams[6])), 2100)); rs[rs.length - 1].conversationMode = 'group';
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(rs) });
    let ticks = 0; while (await p.sweep() && ticks++ < 20);
    const asked = new Set(st.tp.rowsCalls().flatMap(c => c.body.streams.map(s => s.streamId)));
    assert.deepEqual([...asked].sort(), [sid(0), sid(1), sid(2)], 'only the sessions the route takes, whose rows are all here, are asked about');
    const idsOfZero = st.tp.rowsCalls().flatMap(c => c.body.streams.filter(s => s.streamId === sid(0)).flatMap(s => s.rowIds));
    assert.ok(idsOfZero.filter(id => id === 987654).length <= 3, 'the row the station does not hold is asked at most three times (' + idsOfZero.filter(id => id === 987654).length + ')');
    assert.ok(!idsOfZero.includes(undefined), 'a row with no row id is never asked about');
    const saved = p.W.serialize().workstreams.find(w => w.id === sid(0)).history;
    assert.ok(saved.some(r => r.rowId === 987654) && saved.some(r => r.content === 'legacy row, no id') && saved.some(r => r.$ref), 'the lost row and the legacy row stay inline beside the reference to the rows that were proved');
  });

  await run('a row the station says was undone is an answer: asked once, never sealed, left inline as it is', async () => {
    const rs = recs().slice(3, 5);
    const undone = rs[0].history[1].rowId;
    assert.equal(st.store.retract({ streamId: sid(3), rowIds: [undone], reason: 'undo' }).state, 'done');
    st.tp.calls.length = 0;
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(rs) });
    let ticks = 0; while (await p.sweep() && ticks++ < 10);
    const asked = id => st.tp.rowsCalls().flatMap(c => c.body.streams.flatMap(s => s.rowIds)).filter(x => x === id).length;
    assert.equal(asked(undone), 1, 'an undone row is asked once (' + asked(undone) + ')');
    assert.equal(p.W.sealed(sid(3), undone), null, 'and never sealed');
    assert.ok(p.W.serialize().workstreams.find(w => w.id === sid(3)).history.some(r => r.rowId === undone), 'it stays in the conversation, inline, exactly as the page holds it (nothing is dropped here: a reload reads it as undone)');
    assert.equal(p.W.sealCandidates({ any: true }).length, 0, 'and nothing is left to ask');
    // a seal the page kept before the station undid the row goes when a read says so (a deleted turn's text is not kept as proven)
    const keep = rs[0].history.find(r => r.rowId === undone);
    p.W.sealTurns(sid(3), [keep]);
    assert.ok(p.W.sealed(sid(3), undone), '(setup) the page held a seal for it');
    await p.api.sealRows([{ streamId: sid(3), rowIds: [undone] }]);
    assert.equal(p.W.sealed(sid(3), undone), null, 'the read the sweep makes drops it');
  });

  await run('a row that no longer equals what the station holds is proved but stays inline; one that does is named, with the page-only fields it holds beyond the station copy', async () => {
    const rs = recs().slice(0, 2);
    rs[0].history[1].content = 'edited on the page after it was saved';
    rs[0].history[2].typedText = 'typed words';
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(rs) });
    let ticks = 0; while (await p.sweep() && ticks++ < 5);
    const h = p.W.serialize().workstreams.find(w => w.id === sid(0)).history;
    assert.ok(h.some(r => r.content === 'edited on the page after it was saved' && r.rowId), 'the drifted row is saved inline, as it is');
    assert.ok(h.filter(r => r.$ref).length === 2, 'the run is cut around it: ' + JSON.stringify(h.filter(r => r.$ref)));
    const out = await p.HR.expand(h, { streamId: sid(0), fetchRows: async (s, ids) => { const res = { code: 0, body: null }; await st.routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId: s, rowIds: ids }] }) }, res); return res.body.streams[0]; } });
    assert.deepEqual(out.rows, p.W.get(sid(0)).history, 'and it reads back exactly');
  });

  await run('a sweep that stopped half way resumes where the page left off from its own save (nothing is stored), and the idle loop arms and stops itself', async () => {
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(recs()) });
    assert.equal(await p.sweep(), true);   // 50 of 60 sessions
    const mid = JSON.parse(p.persisted[p.persisted.length - 1]);
    const q = Rig.page({ tree: T, tp: st.tp, init: mid });
    assert.equal(q.W.pendingHydration().length, 50, 'the 50 proved sessions boot as references');
    assert.equal(q.W.sealCandidates().length, 10, 'and the 10 the sweep never reached are what is left to prove');
    st.tp.calls.length = 0;
    assert.equal(q.armSweep(), true, 'the idle loop arms when something is left'); assert.equal(q.polls.filter(l => !l.stopped).length, 1);
    await q.polls[0].fn();
    assert.equal(st.tp.rowsCalls().length, 1); assert.equal(q.polls[0].stopped, true, 'and stops itself when nothing is left');
    const r = Rig.page({ tree: T, tp: st.tp, init: JSON.parse(q.persisted[q.persisted.length - 1]) });
    assert.equal(r.armSweep(), false, 'a save with nothing left inline arms nothing');
  });

  await run('the boot arms the sweep whether or not any conversation boots packed (a v6 save has none packed), and the wiring is where the page calls it', async () => {
    const p = Rig.page({ tree: T, tp: st.tp, init: slice(recs()) });
    assert.equal(p.W.pendingHydration().length, 0, 'a save with every row inline boots nothing packed');
    p.arm();   // app.js armHistoryHydration: what init() runs once a save is read
    assert.equal(p.polls.filter(l => !l.stopped).length, 1, 'and the idle sweep is armed all the same');
    const nothing = Rig.page({ tree: T, tp: st.tp, init: slice([record('only', [], 1)]) });
    nothing.arm(); assert.equal(nothing.polls.filter(l => !l.stopped).length, 0, 'a save with nothing to prove arms nothing');
    // the two hooks that live inside the big functions: the run's end schedules the pass right after the history is capped, leaving a conversation schedules it
    const chat = T.chat, app = T.app;
    assert.ok(/capHistory\(ws\);[^\n]*\n\s*if \(typeof sealSoon === 'function'\) sealSoon\(ws\);/.test(chat), 'chat.js: the end of a run schedules its seal pass right after capHistory');
    assert.ok(/prevWs\.id !== nextWs\.id && typeof sealLeft === 'function'\) sealLeft\(prevWs\);/.test(chat), 'chat.js: load() schedules the pass of the conversation it leaves');
    assert.ok(/Workstreams\.setHydrator\(ws => hydrateHistory\(ws, \{ windowMs: 20000 \}\)\)/.test(chat) && /sealRows,\s*sealSoon/.test(chat), 'chat.js hands app.js the sweep\'s reader');
    assert.ok(/function armHistoryHydration\(\) \{\n\s*armSealSweep\(\);/.test(app), 'app.js: armHistoryHydration arms the sweep first');
  });

  await run('reading packed rows back drops the seal of a turn the station says is undone (its own station: the undo stays out of the other cases)', async () => {
    const sh = memoryStation(['hyd'], 4), res = { code: 0, body: null };
    await sh.routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId: 'hyd', rowIds: [1, 2, 3, 4] }] }) }, res);
    const rows = res.body.streams[0].turns;
    assert.equal(rows.length, 4, '(setup) four rows');
    const p0 = Rig.page({ tree: T, tp: sh.tp, init: slice([record('hyd', clone(rows), 1)]) });
    let ticks = 0; while (await p0.sweep() && ticks++ < 5);
    const p = Rig.page({ tree: T, tp: sh.tp, init: JSON.parse(p0.persisted[p0.persisted.length - 1]) });
    assert.ok(p.W.needsHydration('hyd'), '(setup) the conversation boots packed');
    p.W.sealTurns('hyd', [rows[2]]);   // a seal left over from before the station undid the row
    assert.equal(sh.store.retract({ streamId: 'hyd', rowIds: [rows[2].rowId], reason: 'undo' }).state, 'done');
    const got = await p.api.hydrateHistory(p.W.get('hyd'), { windowMs: 20000 });
    assert.equal(got.complete, true, 'the rest of the conversation is read back');
    assert.deepEqual(p.W.get('hyd').history.map(r => r.rowId), [rows[0].rowId, rows[1].rowId, rows[3].rowId], 'without the undone turn');
    assert.equal(p.W.sealed('hyd', rows[2].rowId), null, 'and the page keeps nothing of it as proven');
    assert.notEqual(p.W.sealed('hyd', rows[3].rowId), null, 'the others are proved by that read');
  });
}

async function passScenarios(root) {
  const T = Rig.tree(root), { W, TM } = T;
  const run = async (name, fn) => { try { await fn(); A.ok(true, root + ': ' + name); } catch (e) { A.ok(false, root + ': ' + name + ' — ' + String(e && e.stack || e).split('\n').slice(0, 5).join(' | ')); } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-seal-pass-'));
  let now = 1800000000000;
  const clock = () => ++now, mint = Rig.rng(5);
  const fx = new TurnFixture(dir, clock, {});
  const routes = Rig.routes({ store: fx.store, dual: fx.dual, live: fx.live, isCollided: id => fx.io.isCollided(id) });
  const tp = Rig.transport(routes);
  const p = Rig.page({ tree: T, tp, fakeTimers: true, init: slice([record('a', [], 1), record('b', [], 2)]) });
  // the production run path, as chat.js drives it: pending row, the station's run, the bound directive, the reply, the seal pass scheduled
  const send = async (id, text) => {
    const ws = W.get(id);
    p.busy.add(id);
    const pending = TM.pendingRow({ role: 'user', content: text, ts: clock() }, mint);
    ws.history.push(pending);
    const ids = TM.sendIds(ws.history, { retry: false, now: clock() });
    const result = await fx.run(Object.assign({ streamId: id, agentId: 'agent', messages: [{ role: 'user', content: text }] }, ids), { reply: 'answer to ' + text });
    TM.bindStart(ws.history, result.start, result.runId, ids);
    ws.history.push(TM.ofTurn({ role: 'assistant', content: result.reply, ts: clock(), sourceRunId: result.runId }, { turnId: result.turnId, sourceRunId: result.runId }));
    p.busy.delete(id);
    p.persist();
    if (p.hasSeal) p.api.sealSoon(ws);
  };
  const savedOf = id => JSON.parse(p.persisted[p.persisted.length - 1]).workstreams.find(w => w.id === id).history;

  try {
    await run('a run\'s own rows are saved in full until the seal pass reads them; then they are named, and the conversation on screen was never repainted', async () => {
      assert.ok(p.hasSeal, 'chat.js has the seal pass');
      await send('a', 'first question');
      assert.ok(savedOf('a').every(r => !r.$ref) && savedOf('a').length === 2, 'right after the run its rows are saved as they are');
      assert.equal(p.fire(), 1, 'one timer is pending: the pass waits for the debounce');
      await Rig.flush();
      const repaints = p.renders.n;
      assert.ok(savedOf('a').length === 1 && savedOf('a')[0].$ref, 'the pass read the conversation and the save names its rows (' + JSON.stringify(savedOf('a')).slice(0, 120) + ')');
      assert.equal(p.renders.n, repaints, 'a pass repaints nothing');
      assert.deepEqual(W.get('a').history.map(r => r.content), ['first question', 'answer to first question'], 'and the conversation is the one it was');
    });

    await run('a burst of runs is one read; a conversation on screen is read when the Commander leaves it, not before; one a run is live in or that is still packed is not read', async () => {
      p.open('a');
      await send('a', 'second'); await send('a', 'third');
      assert.equal(p.fire(), 1, 'two run ends inside the debounce are one pending read');
      await Rig.flush();
      assert.ok(savedOf('a').some(r => r.content === 'third'), 'it is on screen: the pass does not read it (a repaint under the Commander\'s eyes is worse than a longer save)');
      const reads = tp.calls.filter(c => c.method === 'GET').length;
      p.open('b'); p.api.sealLeft(W.get('a'));
      assert.equal(p.fire(), 1, 'leaving the conversation schedules its read'); await Rig.flush();
      assert.ok(tp.calls.filter(c => c.method === 'GET').length > reads && savedOf('a').every(r => r.$ref || false) , 'and it is read then: ' + JSON.stringify(savedOf('a')).slice(0, 140));
      // a run is live in it
      p.busy.add('b'); p.api.sealSoon(W.get('b')); p.ctx.activeWs = W.get('a');
      const g = tp.calls.length; p.fire(); await Rig.flush();
      assert.equal(tp.calls.length, g, 'nothing is read while a run is live in the conversation');
      p.busy.clear();
      // a failed read leaves the mark: the next time it is scheduled it reads again
      await send('b', 'only question'); p.ctx.activeWs = W.get('a');
      tp.down = true; p.fire(); await Rig.flush(); tp.down = false;
      assert.ok(!savedOf('b').some(r => r.$ref), 'a station that does not answer leaves the rows as they are');
      p.api.sealSoon(W.get('b')); p.fire(); await Rig.flush();
      assert.ok(savedOf('b').some(r => r.$ref), 'and the next pass reads them');
    });

    await run('a read that failed leaves its mark, so leaving the conversation schedules it again; a conversation that is still packed is not read by the pass at all', async () => {
      p.ctx.activeWs = W.get('a');
      await send('b', 'a second question'); p.fire(); await Rig.flush();   // (the run end schedules the pass; it reads: the rows are named)
      await send('b', 'a third question'); p.ctx.activeWs = W.get('a');
      tp.down = true; p.fire(); await Rig.flush(); tp.down = false;
      const inline = () => savedOf('b').filter(r => !r.$ref && r.content === 'a third question').length;
      assert.equal(inline(), 1, 'a station that does not answer leaves the run\'s rows as they are');
      p.api.sealLeft(W.get('b'));
      assert.equal(p.fire(), 1, 'the failed pass left its mark: leaving the conversation schedules the read again'); await Rig.flush();
      assert.equal(inline(), 0, 'and that read names the rows');
      p.api.sealLeft(W.get('b'));
      assert.equal(p.fire(), 0, 'a read that answered clears its mark: leaving it again schedules nothing');
      // a save that names its rows boots the conversations packed: the pass does not read them (the idle hydration pass does)
      const q = Rig.page({ tree: T, tp, fakeTimers: true, init: JSON.parse(p.persisted[p.persisted.length - 1]) });
      assert.ok(q.W.needsHydration('a') && q.W.needsHydration('b'), '(setup) both boot packed');
      tp.calls.length = 0;
      q.api.sealSoon(q.W.get('a')); q.fire(); await Rig.flush();
      assert.equal(tp.calls.length, 0, 'a packed conversation is not read by the pass: nothing was asked');
      assert.ok(q.W.needsHydration('a'), 'and it is still packed');
    });
  } finally { try { fx.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  for (const root of ROOTS) { await sweepScenarios(root); await passScenarios(root); }
  A.report('history-seal.sweep (the idle sweep and the post-run pass prove rows without anyone opening them; both shipped trees)');
})().catch(e => { console.error(e); process.exit(1); });
