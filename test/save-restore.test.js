'use strict';
// save-restore: a preserved window save's sessions come back into the station and nothing the station holds is lost
// (support report 2026-10-21: a 950-session station, a 1,046-session preserved window save, no way back).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { plan, restorable } = require('../sidecar/save-restore.js');
const { makeSaveStore } = require('../sidecar/savestore.js');

const turn = (role, content) => ({ role, content });
const ws = (id, history, extra) => Object.assign({ id, title: 'S ' + id, agentId: 'agent', lane: 'active', kind: 'chat', history, runIds: [] }, extra || {});
const station = {
  schema: 'starnet.save', version: 6, agent: { id: 'agent', name: 'NOVA' }, station: { floor: 'station floor' }, generalId: 'g-station',
  deletedIds: ['gone'], _saveRevision: 46,
  workstreams: [
    ws('g-station', [turn('user', 'hi')], { title: null }),
    ws('same', [turn('user', 'a'), turn('assistant', 'b')]),
    ws('grown', [turn('user', 'q')]),
    ws('ahead', [turn('user', 'x'), turn('assistant', 'y')]),
    ws('split', [turn('user', 'one'), turn('assistant', 'station answer')]),
    ws('station-only', [turn('user', 'kept')])
  ]
};
const windowSave = {
  schema: 'starnet.save', version: 6, agent: { id: 'agent', name: 'RENAMED IN WINDOW' }, station: { floor: 'window floor' }, generalId: 'g-window',
  deletedIds: ['station-only'], _saveRevision: 45,
  workstreams: [
    ws('g-window', [turn('user', 'hi'), turn('assistant', 'more general')], { title: null }),
    ws('same', [turn('user', 'a'), turn('assistant', 'b')]),
    ws('grown', [turn('user', 'q'), turn('assistant', 'answer the station never saved')]),
    ws('ahead', [turn('user', 'x')]),
    ws('split', [turn('user', 'one'), turn('assistant', 'window answer')]),
    ws('new-1', [turn('user', 'routine run while away')]),
    ws('worker', [turn('user', 'sub')], { parentStreamId: 'g-window', worker: true }),
    ws('gone', [turn('user', 'deleted on purpose in the station')])
  ]
};
const before = JSON.stringify(station), beforeWindow = JSON.stringify(windowSave);
const r = plan(station, windowSave);
assert.equal(JSON.stringify(station), before, 'the station object is not modified');
assert.equal(JSON.stringify(windowSave), beforeWindow, 'the preserved save is not modified');
const by = id => r.doc.workstreams.find(w => w.id === id);

assert.deepEqual(r.added, ['new-1', 'worker'], 'sessions the station lacks are added');
assert.equal(by('worker').parentStreamId, 'g-station', 'a worker under the window\'s General files under the station\'s');
assert.deepEqual(r.extended.sort(), ['g-station', 'grown'], 'a continued conversation is taken whole');
assert.equal(by('grown').history.length, 2);
assert.equal(by('g-station').history.length, 2, 'the window\'s General is the station\'s General');
assert.equal(r.doc.workstreams.filter(w => w.title == null).length, 1, 'never a second General');
assert.equal(by('ahead').history.length, 2, 'the station\'s longer copy stays');
assert.deepEqual(r.copied, ['split~restored'], 'a session both sides changed keeps both');
assert.equal(by('split').history[1].content, 'station answer');
assert.equal(by('split~restored').history[1].content, 'window answer');
assert.equal(by('split~restored').title, 'S split (restored copy)');
assert.equal(by('gone'), undefined, 'a session the station deleted stays deleted');
assert.ok(by('station-only'), 'the window\'s delete never removes a station session');
for (const w of station.workstreams) assert.ok(by(w.id), 'nothing the station holds is lost: ' + w.id);
assert.equal(r.doc.agent.name, 'NOVA', 'the roster stays the station\'s');
assert.deepEqual(r.doc.station, station.station, 'the floor stays the station\'s');
assert.deepEqual(r.doc.deletedIds, ['gone']);
assert.equal(restorable(station, windowSave), 5);

const again = plan(r.doc, windowSave);
assert.deepEqual([again.added, again.extended, again.copied], [[], [], []], 'a second restore brings nothing back twice');
assert.equal(restorable(r.doc, windowSave), 0, 'so a notice never offers it again');
assert.equal(restorable(station, { workstreams: 'not a list' }), 0);

// save-latch-kill: a refused save is now merged IN-SESSION, so a session two windows keep writing diverges again and again. A
// copy an earlier merge made is continued; a new divergence gets the next copy; the same save twice still brings nothing twice;
// a copy the Commander deleted is never refilled. (A second divergence used to stay out of the station entirely.)
{
  const st = { generalId: 'g', deletedIds: [], workstreams: [
    ws('g', [turn('user', 'hi'), turn('assistant', 'station 1')], { title: null }),
    ws('g~restored', [turn('user', 'hi'), turn('assistant', 'window 1')], { title: 'General (restored copy)' })] };
  const cont = { generalId: 'g', workstreams: [ws('g', [turn('user', 'hi'), turn('assistant', 'window 1'), turn('user', 'window 1 more')], { title: null })] };
  const p1 = plan(st, cont);
  assert.deepEqual([p1.added, p1.extended, p1.copied], [[], ['g~restored'], []], 'latch-kill: a window that continued its earlier copy extends that copy');
  assert.deepEqual(p1.doc.workstreams.find(w => w.id === 'g~restored').history.map(t => t.content), ['hi', 'window 1', 'window 1 more']);
  assert.deepEqual(p1.doc.workstreams.find(w => w.id === 'g').history.map(t => t.content), ['hi', 'station 1'], 'latch-kill: the station\'s own session is untouched');
  const third = { generalId: 'g', workstreams: [ws('g', [turn('user', 'hi'), turn('assistant', 'window 2')], { title: null })] };
  const p2 = plan(st, third);
  assert.deepEqual(p2.copied, ['g~restored2'], 'latch-kill: a session that diverged again gets the next copy');
  assert.equal(restorable(st, third), 1, 'latch-kill: and the offer counts it');
  assert.deepEqual([plan(p2.doc, third).copied, plan(p2.doc, third).extended], [[], []], 'latch-kill: the same save twice brings nothing twice');
  // a restored copy the Commander deleted is never refilled (that id stays deleted) — and the work it held, deleted on purpose
  // after it was last worked in (the time-scoped deleted-session ledger), never comes back
  const dismissed = { generalId: 'g', deletedIds: ['g~restored'], workstreams: [st.workstreams[0]] };
  const third0 = { generalId: 'g', workstreams: [ws('g', [turn('user', 'hi'), turn('assistant', 'window 2')], { title: null, lastActiveAt: 1000 })] };
  const deletedLater = (id, ts) => id === 'g~restored' && ts <= 2000;   // the copy was deleted at 2000, after this work (1000)
  assert.deepEqual([plan(dismissed, third0, { forgotten: deletedLater }).copied, restorable(dismissed, third0, { forgotten: deletedLater })], [[], 0],
    'latch-kill: work deleted on purpose with its restored copy never comes back');
  // review 10-27: a DIFFERENT divergence after that delete (worked in after it, or a deletion only the station's own list records)
  // takes the next free slot — the deleted one is never refilled, and nothing is dropped without a word
  const later = { generalId: 'g', workstreams: [ws('g', [turn('user', 'hi'), turn('assistant', 'window 3, after the delete')], { title: null, lastActiveAt: 3000 })] };
  const pl = plan(dismissed, later, { forgotten: deletedLater });
  assert.deepEqual([pl.copied, restorable(dismissed, later, { forgotten: deletedLater })], [['g~restored2'], 1], 'latch-kill: a later divergence takes the next slot, never the deleted one');
  assert.ok(!pl.doc.workstreams.some(w => w.id === 'g~restored'), 'latch-kill: the deleted copy stays deleted');
  assert.deepEqual(plan(dismissed, third).copied, ['g~restored2'], 'latch-kill: without the ledger (no time), a deleted slot is skipped, never refilled, and the work is kept');
  // every slot taken: UNPLACED — reported, never silently dropped
  const full = { generalId: 'g', deletedIds: [], workstreams: [st.workstreams[0]] };
  for (let n = 1; n <= 20; n++) full.workstreams.push(ws('g~restored' + (n > 1 ? n : ''), [turn('user', 'hi'), turn('assistant', 'copy ' + n)], { title: 'General (restored copy)' }));
  const pf = plan(full, later);
  assert.deepEqual([pf.copied, pf.unplaced], [[], ['g']], 'latch-kill: with every restored-copy slot taken, the session is reported unplaced');
  assert.equal(restorable(full, later), 0, 'latch-kill: and nothing is offered that a restore could not bring back');
}

// review 10-23 #3b (proof3): a CLEARED station session is not "behind", and extending a session appends only the missing
// turns while every station-side field stays the station's ("nothing in the station is removed" holds for metadata too)
{
  const st = { generalId: 'g', deletedIds: [], workstreams: [
    { id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'cleared', title: 'Payroll', history: [], lastActiveAt: 900 },
    { id: 'renamed', title: 'Q4 plan (final)', archived: true, pinned: false, lane: 'shipped', runIds: ['run-s'], deliverables: ['d.md'], history: [turn('user', 'plan q4')] },
    { id: 'new-empty', title: 'Fresh', history: [], lastActiveAt: 100 },
    { id: 'checkpointed', title: 'C', history: [], lastActiveAt: 100 },
    { id: 'cleared-then-used', title: 'U', history: [turn('user', 'after the clear')] },
    { id: 'born-empty', title: 'B', history: [], createdAt: 500, lastActiveAt: 500 }
  ], sessionUndo: { kind: 'clear', at: 950, activeId: 'g', rows: [{ id: 'checkpointed', history: [turn('user', 'secret')] }, { id: 'cleared-then-used', history: [turn('user', 'secret 2')] }] } };
  const kept = { generalId: 'g', workstreams: [
    { id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'cleared', title: 'Payroll', history: [turn('user', 'salary of each employee'), turn('assistant', '...')], lastActiveAt: 800 },
    { id: 'renamed', title: 'Q4 plan', archived: false, pinned: true, lane: 'active', runIds: ['run-w'], deliverables: [], history: [turn('user', 'plan q4'), turn('assistant', 'draft')] },
    { id: 'new-empty', title: 'Fresh', history: [turn('user', 'typed in the other window')], lastActiveAt: 200 },
    { id: 'checkpointed', title: 'C', history: [turn('user', 'secret')], lastActiveAt: 999 },
    { id: 'cleared-then-used', title: 'U', history: [turn('user', 'secret 2')] },
    { id: 'born-empty', title: 'B', history: [turn('user', 'asked before the run finished')], createdAt: 500, lastActiveAt: 500 }
  ] };
  const stBefore = JSON.stringify(st);
  const p = plan(st, kept);
  const at = id => p.doc.workstreams.find(w => w.id === id);
  assert.equal(JSON.stringify(st), stBefore, '3b: the station object is not modified');
  assert.equal(at('cleared').history.length, 0, '3b: a session cleared after the window last used it stays cleared');
  const ren = at('renamed');
  assert.deepEqual(ren.history.map(t => t.content), ['plan q4', 'draft'], '3b: the missing turn is appended');
  assert.deepEqual({ title: ren.title, archived: ren.archived, pinned: ren.pinned, lane: ren.lane, runIds: ren.runIds, deliverables: ren.deliverables },
    { title: 'Q4 plan (final)', archived: true, pinned: false, lane: 'shipped', runIds: ['run-s'], deliverables: ['d.md'] }, '3b: every station-side field stays the station\'s');
  assert.deepEqual(at('new-empty').history.map(t => t.content), ['typed in the other window'], '3b: an empty session the window worked in AFTER the station last did gets its turns');
  assert.equal(at('checkpointed').history.length, 0, '3b: a session the station\'s clear checkpoint names is never refilled');
  assert.equal(at('cleared-then-used~restored'), undefined, '3b: nor copied back beside the station\'s new turns');
  assert.equal(at('born-empty').history.length, 1, '3b: an empty session never active since it was created (so never cleared) gets the turns');
  assert.deepEqual([p.added, p.extended.sort(), p.copied], [[], ['born-empty', 'new-empty', 'renamed'], []]);
  assert.equal(restorable(st, kept), 3, '3b: the offer counts exactly what a restore brings back');
  // 3c: the sidecar's deleted-session ledger (opts.forgotten = sessionTombstones.forgotten) wins like the save's own deletedIds
  const withDeleted = { generalId: 'g', workstreams: [{ id: 'ledger-deleted', history: [turn('user', 'x')] }, { id: 'renamed~restored', history: [turn('user', 'y')] }] };
  const del = (id, ts) => id === 'ledger-deleted' && ts <= 5000;
  assert.deepEqual(plan(st, withDeleted, { forgotten: del }).added, ['renamed~restored'], '3c: a ledger-deleted session is never added');
  assert.equal(restorable(st, withDeleted, { forgotten: del }), 1, '3c: nor counted');
}

// review 10-23 r2 #3: the ledger is TIME-SCOPED (session-tombstones.js forgotten(id, ts) = ts <= deletedAt). A session revived
// after its delete (Workstreams.adopt revive: the briefing, a project's home session) keeps its ledger stamp by design:
// the station holds it live, so a stale window's newer turns in it come back; a session the station lacks comes back only
// when the window worked in it AFTER the delete
{
  const deletedAt = { R: 3000, gone: 3000, 'back-later': 3000 };
  const forgotten = (id, ts) => (deletedAt[id] || 0) > 0 && Number(ts) <= deletedAt[id];
  const st = { generalId: 'g', deletedIds: [], workstreams: [{ id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'R', title: 'Briefing', createdAt: 1000, lastActiveAt: 4000, history: [turn('user', 'r1')] }] };
  const kept = { generalId: 'g', workstreams: [{ id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'R', title: 'Briefing', createdAt: 1000, lastActiveAt: 4500, history: [turn('user', 'r1'), turn('user', 'r2 typed in the stale window')] },
    { id: 'gone', title: 'Deleted', createdAt: 1000, lastActiveAt: 2500, history: [turn('user', 'said before the delete')] },
    { id: 'back-later', title: 'Reopened there', createdAt: 1000, lastActiveAt: 3500, history: [turn('user', 'said after the delete')] }] };
  const p = plan(st, kept, { forgotten });
  assert.deepEqual(p.extended, ['R'], 'r2 #3: a revived session the station holds live is extended (never "deleted")');
  assert.deepEqual(p.doc.workstreams.find(w => w.id === 'R').history.map(t => t.content), ['r1', 'r2 typed in the stale window']);
  assert.deepEqual(p.added, ['back-later'], 'r2 #3: a session worked in after its delete comes back; one last used before it stays deleted');
  assert.equal(restorable(st, kept, { forgotten }), 2, 'r2 #3: the offer counts exactly those');
  // the save's own deletedIds still wins outright (it carries no time, and only lists rows the station removed)
  assert.deepEqual(plan(Object.assign({}, st, { deletedIds: ['back-later'] }), kept, { forgotten }).added, [], 'r2 #3: deletedIds still wins');
}

// review 10-23 r2 #2: the clear checkpoint is TIME-SCOPED. A window behind the clear that kept working in the session AFTER
// it brings back only what it added after the cleared turns; what it held when the session was cleared stays cleared
{
  const cleared = [turn('user', 'o1 (cleared)'), turn('assistant', 'o2 (cleared)')];
  const st = { generalId: 'g', deletedIds: [], workstreams: [{ id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'X', title: 'Payroll', createdAt: 1000, lastActiveAt: 2000, history: [] },
    { id: 'Y', title: 'Continued', createdAt: 1000, lastActiveAt: 2600, history: [turn('user', 'station after the clear')] }],
    sessionUndo: { kind: 'clear', at: 2000, activeId: 'X', rows: [{ id: 'X', history: cleared }, { id: 'Y', history: cleared }] } };
  const behind = { generalId: 'g', workstreams: [{ id: 'g', title: null, history: [turn('user', 'hi')] },
    { id: 'X', title: 'Payroll', createdAt: 1000, lastActiveAt: 3000, history: cleared.concat([turn('user', 'b1 typed AFTER the clear')]) },
    { id: 'Y', title: 'Continued', createdAt: 1000, lastActiveAt: 3000, history: [cleared[0], turn('user', 'y1 typed AFTER the clear')] }] };
  const p = plan(st, behind);
  const at = id => p.doc.workstreams.find(w => w.id === id);
  assert.deepEqual(at('X').history.map(t => t.content), ['b1 typed AFTER the clear'], 'r2 #2: the post-clear turn comes back; the cleared ones do not');
  assert.deepEqual(at('Y~restored').history.map(t => t.content), ['y1 typed AFTER the clear'], 'r2 #2: beside a continued session, the copy holds only post-clear turns');
  assert.equal(at('Y').history.length, 1, 'r2 #2: the station\'s continued session is untouched');
  assert.ok(!JSON.stringify(p.doc.workstreams).includes('(cleared)'), 'r2 #2: no cleared turn is in any restored session');
  assert.equal(restorable(st, behind), 2);
  // a copy last active at or before the clear brings nothing back for that session
  const before = { generalId: 'g', workstreams: [{ id: 'X', title: 'Payroll', lastActiveAt: 2000, history: cleared.concat([turn('user', 'typed before the clear')]) }] };
  assert.equal(restorable(st, before), 0, 'r2 #2: a copy from before the clear brings nothing back');
}

// the store lists preserved saves newest first and copies the station file aside before a restore
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-restore-'));
try {
  const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => 1000 } });
  assert.deepEqual(store.conflicts('agent'), []);
  assert.equal(store.backup('agent', 'restore-1'), null, 'no station file, nothing to copy');
  assert.equal(store.save('agent', { ...station, _saveRevision: 0 }, { compareRevision: true }).revision, 1000, 'a first save on an empty file takes the clock revision (review 10-23 #2)');
  const refused = store.save('agent', { ...windowSave, _saveRevision: 0, _saveClient: 'window-a' }, { compareRevision: true });
  assert.equal(refused.recovery, 'agent.save-conflict-window-a.json');
  fs.writeFileSync(path.join(root, 'agent.save-conflict-torn.json'), '{"workstreams":[');
  fs.writeFileSync(path.join(root, 'other.save-conflict-x.json'), '{}');
  const listed = store.conflicts('agent');
  assert.deepEqual(listed.map(c => c.name), ['agent.save-conflict-window-a.json'], 'a torn snapshot is skipped and another agent\'s is never listed');
  assert.equal(listed[0].doc.workstreams.length, windowSave.workstreams.length);
  assert.ok(fs.existsSync(path.join(root, 'agent.save-conflict-torn.json')), 'a torn snapshot is never removed');
  const copy = store.backup('agent', 'restore-1');
  assert.equal(copy, 'agent.save-before-restore-1.json');
  assert.equal(fs.readFileSync(path.join(root, copy), 'utf8'), fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'));
  assert.throws(() => store.backup('agent', '../escape'));
  assert.throws(() => store.conflicts('../agent'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('save-restore: preserved sessions return, nothing is lost, General maps, tombstones hold, store lists and backs up PASS');
