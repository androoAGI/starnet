/* test/save-merge.test.js — the three-way merge a window another window saved past is saved through (save-latch-kill,
   review 10-27). sidecar/save-merge.js merges the window's save onto the station file as it is, from what the window changed
   since the station last took its work (frontend/app/cloudsavecore.js mergeDelta). The review found the first in-session
   merge (the boot merge's rules: the station the base, sessions added) dropped every change of the window that was not a
   session turn while saying it was merged, and made a new full-history "(restored copy)" for every divergence of a shared
   session. Locked here:
     • a field only this window changed lands (the hero, a crew row, settings, a session's title); one it did not change keeps
       another window's change; one both changed takes this window's (counted); a counter keeps both additions;
     • a session: this window's new turns go after the station's, never twice and never as a copy; a history it rewrote (a
       clear) stands with the station's later turns after it; its deletes land; another window's deletes stand, and what this
       window did in such a session is REPORTED lost, never dropped without a word;
     • the growth projection comes whole from the newer rating watermark;
     • write(): nothing to add writes nothing; a merge is written on the station file's own revision as adopt-<window>; the
       refused copy the window left is removed once the station holds all of it; what could not land is kept beside the
       station once per window; permanent refusals say so. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../frontend/app/cloudsavecore.js');
const SaveMerge = require('../sidecar/save-merge.js');
const { makeSaveStore } = require('../sidecar/savestore.js');

const clone = v => JSON.parse(JSON.stringify(v));
const T = (c, ts) => ({ role: 'user', content: c, ts: ts || 0 });
const contents = w => (w ? w.history : []).map(t => t.content);
const sess = (doc, id) => doc.workstreams.find(w => w.id === id);
function station0() {
  return { schema: 'starnet.save', version: 6, updatedAt: 1000, _saveRevision: 4, _saveClient: 'w-a',
    agent: { id: 'agent', name: 'NOVA', createdAt: 5000, model: 'm1', stats: { xp: 1 } },
    agents: [{ id: 'agent', name: 'NOVA', stats: { xp: 1 } }, { id: 'c1', name: 'Ada', model: 'x', reasoningEffort: 'low', stats: { xp: 3 } }],
    usage: { tokens: 100, cost: 1, calls: 10 }, station: { props: [{ id: 'p1', t: 'desk', x: 1 }], name: 'deck' },
    stationStats: { ratingSyncAt: 50, ratingSyncVersion: 2, xp: 9 },
    generalId: 'general', activeId: 'general', deletedIds: [], forgetIds: [],
    workstreams: [
      { id: 'general', title: null, cost: { tokens: 10, usd: 0.1, calls: 1 }, lastActiveAt: 100, history: [T('hello', 1), T('there', 2)] },
      { id: 'S1', title: 'Old title', lastActiveAt: 100, history: [T('s1 a', 3)] },
      { id: 'S2', title: 'Two', lastActiveAt: 100, history: [T('s2 a', 4)] }
    ] };
}
const merge = (station, base, mine) => SaveMerge.merge(station, mine, Core.mergeDelta(base, mine), {});

// ---- mergeDelta: what the window changed, never the whole base again ----
{
  const base = station0(), mine = clone(base);
  mine.agent.name = 'RENAMED';
  sess(mine, 'general').history.push(T('mine 1', 10));
  sess(mine, 'S1').history = [];                      // a clear: a rewrite
  mine.workstreams = mine.workstreams.filter(w => w.id !== 'S2');
  mine.workstreams.push({ id: 'N1', title: 'New', history: [T('n', 11)] });
  const d = Core.mergeDelta(base, mine);
  A.eq(d.top.map(t => t.k).sort(), ['agent'], 'delta: only the changed field is listed (with its base value)');
  A.eq(d.top[0].b.name, 'NOVA', 'delta: the base value rides along');
  const g = d.rows.find(r => r.id === 'general');
  A.ok(g && g.bLen === 2 && g.b && g.b.history === undefined, 'delta: an append-only session sends its base WITHOUT its history (bLen = base turns)');
  const s1 = d.rows.find(r => r.id === 'S1');
  A.ok(s1 && s1.bLen === undefined && Array.isArray(s1.b.history) && s1.b.history.length === 1, 'delta: a rewritten history sends the base history');
  A.ok(d.rows.some(r => r.id === 'N1' && !('b' in r)), 'delta: a new session has no base');
  A.eq(d.gone, ['S2'], 'delta: a deleted session is listed gone');
  A.eq(Core.mergeDelta(base, clone(base)), { v: 1, top: [], rows: [], gone: [] }, 'delta: an unchanged save lists nothing');
  A.ok(Core.deepEq({ a: 1, b: undefined }, { a: 1 }) && !Core.deepEq([1, 2], [2, 1]) && Core.deepEq({ x: [{ y: 'z' }] }, { x: [{ y: 'z' }] }), 'deepEq: JSON equality');
}

// ---- the reviewer's case: a behind window renames the hero, recruits, renames a session — none of it may be dropped ----
{
  const base = station0();
  const station = clone(base);                         // another window saved since: a new session and a change to Ada
  station.workstreams.push({ id: 'A1', title: 'From A', history: [T('a1', 20)] });
  station.agents[1].reasoningEffort = 'high';
  station._saveRevision = 5;
  const mine = clone(base);
  mine.agent.name = 'RENAMED-IN-B'; mine.agents[0].name = 'RENAMED-IN-B';
  mine.agents.push({ id: 'c2', name: 'NEW CREW', model: 'y' });
  sess(mine, 'S1').title = 'New title';
  mine.station.props.push({ id: 'p2', t: 'lamp', x: 2 });
  const r = merge(station, base, mine);
  A.ok(r.changed, 'merge: the window brought changes');
  A.eq(r.doc.agent.name, 'RENAMED-IN-B', 'merge: the hero rename lands');
  A.eq(r.doc.agents.map(a => a.id), ['agent', 'c1', 'c2'], 'merge: the new crew member lands, the other window\'s crew stays');
  A.eq(r.doc.agents[1].reasoningEffort, 'high', 'merge: the other window\'s change to Ada stays (this window did not change her)');
  A.eq(sess(r.doc, 'S1').title, 'New title', 'merge: the session rename lands');
  A.ok(!!sess(r.doc, 'A1'), 'merge: the other window\'s new session stays');
  A.eq(r.doc.station.props.map(p => p.id), ['p1', 'p2'], 'merge: the floor change lands');
  A.eq([r.overrode.length, r.lost.length], [0, 0], 'merge: nothing overridden, nothing lost');
}

// ---- both changed one field: this window's (the newest edit) wins, counted; counters keep both; stamps the later ----
{
  const base = station0();
  const station = clone(base); station.agent.model = 'theirs'; station.usage = { tokens: 150, cost: 1.5, calls: 12 };
  sess(station, 'general').cost = { tokens: 30, usd: 0.3, calls: 3 }; sess(station, 'general').history.push(T('theirs 1', 21)); sess(station, 'general').lastActiveAt = 300;
  const mine = clone(base); mine.agent.model = 'mine'; mine.usage = { tokens: 120, cost: 1.2, calls: 11 };
  sess(mine, 'general').cost = { tokens: 15, usd: 0.15, calls: 2 }; sess(mine, 'general').history.push(T('mine 1', 22)); sess(mine, 'general').lastActiveAt = 200;
  const r = merge(station, base, mine);
  A.eq(r.doc.agent.model, 'mine', 'conflict: both changed it — this window\'s change is the one being saved now');
  A.ok(r.overrode.indexOf('agent.model') !== -1, 'conflict: counted as overrode');
  A.eq(r.doc.usage, { tokens: 170, cost: 1.7, calls: 13 }, 'counter: lifetime usage keeps both windows\' additions');
  A.eq(sess(r.doc, 'general').cost.tokens, 35, 'counter: a session\'s cost keeps both additions');
  A.eq(sess(r.doc, 'general').lastActiveAt, 300, 'stamp: the later time');
  A.eq(contents(sess(r.doc, 'general')), ['hello', 'there', 'theirs 1', 'mine 1'], 'turns: this window\'s new turn goes after the station\'s, in one session');
  A.ok(!r.doc.workstreams.some(w => /~restored/.test(w.id)), 'turns: never a restored copy');
}

// ---- a shared session written by two windows, round after round: no copies, no duplicates, no turn lost ----
{
  let station = station0(), baseA = clone(station), baseB = clone(station);
  let mineA = clone(baseA), mineB = clone(baseB);
  const typed = [];
  for (let round = 0; round < 60; round++) {
    const ta = T('A' + round, 1000 + round * 2), tb = T('B' + round, 1001 + round * 2);
    sess(mineA, 'general').history.push(ta); sess(mineB, 'general').history.push(tb); typed.push(ta.content, tb.content);
    let r = merge(station, baseA, mineA); if (r.changed) station = r.doc; baseA = clone(mineA);
    r = merge(station, baseB, mineB); if (r.changed) station = r.doc; baseB = clone(mineB);
    if (round === 30) { r = merge(station, clone(baseB), mineB); A.ok(!r.changed, 'rounds: merging the same save again (a lost answer) changes nothing'); }
  }
  const g = contents(sess(station, 'general'));
  A.ok(typed.every(t => g.indexOf(t) !== -1), 'rounds: every turn either window typed is in the station\'s General');
  A.eq(g.length, new Set(g).size, 'rounds: and none twice');
  A.eq(station.workstreams.length, 3, 'rounds: no restored copies were made (' + station.workstreams.map(w => w.id) + ')');
  A.ok(JSON.stringify(station).length < 20000, 'rounds: the station grows by the turns typed, never by copies of the conversation');
  // a lost answer: the window merges its NEXT save from its OLD base — nothing twice
  const before = clone(station), oldBase = clone(mineA);
  sess(mineA, 'general').history.push(T('A-late', 5000));
  let r = merge(station, oldBase, mineA); station = r.doc;
  sess(mineA, 'general').history.push(T('A-later', 5001));
  r = merge(station, oldBase, mineA);
  const g2 = contents(sess(r.doc, 'general'));
  A.eq(g2.filter(t => t === 'A-late').length, 1, 'lost answer: a turn merged once is not merged twice from the same base');
  A.ok(g2.indexOf('A-later') !== -1 && contents(sess(before, 'general')).every(t => g2.indexOf(t) !== -1), 'lost answer: the newer turn lands, nothing is lost');
}

// ---- a history this window rewrote (a clear) stands; the station's later turns stay after it ----
{
  const base = station0();
  const station = clone(base); sess(station, 'S1').history.push(T('other window, after', 30));
  const mine = clone(base); sess(mine, 'S1').history = []; mine.sessionUndo = { kind: 'clear', at: 25, rows: [{ id: 'S1', history: base.workstreams[1].history }] };
  const r = merge(station, base, mine);
  A.eq(contents(sess(r.doc, 'S1')), ['other window, after'], 'rewrite: this window\'s clear stands, with the other window\'s later turn after it');
  A.eq(r.doc.sessionUndo && r.doc.sessionUndo.kind, 'clear', 'rewrite: the clear checkpoint lands with it');
}

// ---- deletes: this window's land; another window's stand, and what this window did there is REPORTED ----
{
  const base = station0();
  const station = clone(base); station.workstreams = station.workstreams.filter(w => w.id !== 'S2'); station.deletedIds = ['S2']; station.agents = station.agents.filter(a => a.id !== 'c1');
  const mine = clone(base);
  mine.workstreams = mine.workstreams.filter(w => w.id !== 'S1'); mine.deletedIds = ['S1'];   // this window deleted S1
  sess(mine, 'S2').history.push(T('typed into S2 after the other window deleted it', 40));
  mine.agents[1].model = 'changed here';
  const r = merge(station, base, mine);
  A.ok(!sess(r.doc, 'S1') && r.removed.indexOf('S1') !== -1, 'delete: this window\'s delete lands');
  A.ok(!sess(r.doc, 'S2'), 'delete: another window\'s delete stands');
  A.eq(r.doc.deletedIds.slice().sort(), ['S1', 'S2'], 'delete: both deleted-session lists are kept');
  A.ok(r.lost.some(x => x.kind === 'session' && x.id === 'S2') && r.lost.some(x => x.kind === 'row' && x.id === 'c1'), 'delete: what this window did in a session / crew row another window deleted is reported lost (' + JSON.stringify(r.lost) + ')');
  const quiet = clone(base); quiet.workstreams = quiet.workstreams.filter(w => w.id !== 'S1'); quiet.deletedIds = ['S1'];
  A.eq(merge(station, base, quiet).lost, [], 'delete: a session this window did not touch, deleted elsewhere: nothing lost');
}

// ---- growth: whole, from the newer watermark; never back ----
{
  const base = station0();
  const station = clone(base); station.stationStats = { ratingSyncAt: 80, ratingSyncVersion: 2, xp: 20 }; station.agents[1].stats = { xp: 7 };
  const mine = clone(base); mine.agents[1].stats = { xp: 4 };   // this window's own (older) projection
  let r = merge(station, base, mine);
  A.eq([r.doc.stationStats.xp, r.doc.agents[1].stats.xp, r.changed], [20, 7, false], 'growth: an older projection never replaces the station\'s (and is no change)');
  const ahead = clone(base); ahead.stationStats = { ratingSyncAt: 90, ratingSyncVersion: 2, xp: 25 }; ahead.agents[1].stats = { xp: 8 };
  r = merge(station, base, ahead);
  A.eq([r.doc.stationStats.xp, r.doc.agents[1].stats.xp], [25, 8], 'growth: a newer projection is taken whole');
}

// ---- write(): through a real store ----
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-merge-'));
  try {
    let now = 10_000;
    const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => now } });
    const s0 = station0(); s0._saveRevision = 0;
    A.ok(store.save('agent', s0, { compareRevision: true }).ok, 'write: fixture station');
    const base = clone(store.load('agent'));
    // window B saves past it
    const other = clone(base); other.workstreams.push({ id: 'B1', title: 'B', history: [T('b', 50)] }); other._saveClient = 'w-b'; other.updatedAt = 2000;
    A.ok(store.save('agent', other, { compareRevision: true }).ok, 'write: another window saves');
    // window A's plain save is refused and preserved beside the station
    const mine = clone(base); mine._saveClient = 'w-a'; mine._saveDirty = true; mine.updatedAt = 3000; mine.agent.name = 'ALPHA';
    const refused = store.save('agent', mine, { compareRevision: true });
    A.ok(refused.conflict === true && refused.recovery, 'write: window A\'s plain save is refused and preserved');
    const conflictFiles = () => fs.readdirSync(root).filter(n => /^agent\.save-conflict-.*\.json$/.test(n));
    A.eq(conflictFiles().length, 1, 'write: one refused copy on disk');
    const body = Object.assign(clone(mine), { _saveMerge: Object.assign({ by: 'w-a' }, Core.mergeDelta(base, mine)) });
    now = 20_000;
    let out = SaveMerge.write(clone(body), { saveStore: store, agentId: 'agent', now });
    A.ok(out.status === 200 && out.body.ok && out.body.merged && out.wrote, 'write: the merge lands (' + JSON.stringify(out.body) + ')');
    const st = store.load('agent');
    A.eq([st.agent.name, !!sess(st, 'B1'), st._saveClient], ['ALPHA', true, 'adopt-w-a'], 'write: A\'s rename and B\'s session are both in the station file, written as adopt-<window>');
    A.ok(st._saveRevision > other._saveRevision, 'write: on a new revision (the revision check is never relaxed)');
    A.eq(conflictFiles(), [], 'write: the refused copy is gone once the station holds all of it (no pile of copies to prune older ones away)');
    A.ok(out.body.backup && fs.existsSync(path.join(root, out.body.backup)), 'write: the station file from before is copied aside');
    // the same save again: nothing to add, nothing written, no backup
    const revBefore = st._saveRevision;
    out = SaveMerge.write(clone(body), { saveStore: store, agentId: 'agent', now: 21_000 });
    A.ok(out.body.ok && out.body.unchanged && !out.wrote && store.load('agent')._saveRevision === revBefore, 'write: a merge that brings nothing writes nothing');
    // its next change: the head is its own merge, so no second backup
    const mine2 = clone(mine); mine2.agent.model = 'm2';
    out = SaveMerge.write(Object.assign(clone(mine2), { _saveMerge: Object.assign({ by: 'w-a' }, Core.mergeDelta(mine, mine2)) }), { saveStore: store, agentId: 'agent', now: 22_000 });
    A.ok(out.body.ok && out.wrote && !out.body.backup, 'write: a merge right after this window\'s own merge copies nothing aside');
    // what could not land is kept, once per window
    const del = clone(store.load('agent')); del.workstreams = del.workstreams.filter(w => w.id !== 'S2'); del.deletedIds = ['S2']; del._saveClient = 'w-b'; del.updatedAt = 30_000;
    A.ok(store.save('agent', del, { compareRevision: true }).ok, 'write: window B deletes S2');
    const mine3 = clone(mine2); sess(mine3, 'S2').history.push(T('into a deleted session', 60));
    for (let i = 0; i < 2; i++) {
      out = SaveMerge.write(Object.assign(clone(mine3), { _saveMerge: Object.assign({ by: 'w-a' }, Core.mergeDelta(mine2, mine3)) }), { saveStore: store, agentId: 'agent', now: 31_000 + i });
    }
    A.ok(out.body.ok && out.body.lost.some(x => x.id === 'S2') && out.body.kept === 'agent.save-conflict-kept-w-a.json', 'write: a change that cannot land is reported, with the copy kept (' + JSON.stringify(out.body) + ')');
    A.eq(conflictFiles(), ['agent.save-conflict-kept-w-a.json'], 'write: ONE kept copy per window, overwritten by its later rounds');
    A.ok(fs.readFileSync(path.join(root, 'agent.save-conflict-kept-w-a.json'), 'utf8').includes('into a deleted session'), 'write: the kept copy holds the turn');
    // permanent refusals say what they are
    const alien = Object.assign(clone(body), { agent: Object.assign({}, body.agent, { createdAt: 999 }) });
    A.eq(Core.mergeRefusal(SaveMerge.write(alien, { saveStore: store, agentId: 'agent', now }).body), 'permanent', 'write: another station is refused for good');
    const older = Object.assign(clone(body), { version: 5 });
    A.eq(Core.mergeRefusal(SaveMerge.write(older, { saveStore: store, agentId: 'agent', now }).body), 'permanent', 'write: a newer station save format is refused for good');
    const big = clone(mine3); big.agent.bio = 'x'.repeat(4000);
    const bigOut = SaveMerge.write(Object.assign(clone(big), { _saveMerge: Object.assign({ by: 'w-a' }, Core.mergeDelta(mine3, big)) }), { saveStore: store, agentId: 'agent', now, cap: (64 << 10) + 3000 });
    A.ok(bigOut.body.tooLarge === true && Core.mergeRefusal(bigOut.body) === 'tooLarge' && !store.load('agent').agent.bio, 'write: a merge too large to save is refused as too large (asked again later: a smaller save can land), and nothing is written');
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'save-merge-empty-'));
    const empty = makeSaveStore({ fs, pathMod: path, root: emptyRoot, clock: { now: () => now } });
    A.eq(Core.mergeRefusal(SaveMerge.write(clone(body), { saveStore: empty, agentId: 'agent', now }).body), 'absent', 'write: no station file: the plain save seeds it');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    const locked = { loadState: () => ({ status: 'unreadable' }) };
    A.eq(Core.mergeRefusal(SaveMerge.write(clone(body), { saveStore: locked, agentId: 'agent', now }).body), 'passing', 'write: a station file locked right now is asked again, never latched');
    A.eq(SaveMerge.write(Object.assign(clone(body), { _saveMerge: { by: 'w-a' } }), { saveStore: store, agentId: 'agent', now }).status, 400, 'write: a merge without its description is a bad request');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('save-merge');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
