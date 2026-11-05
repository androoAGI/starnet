/* node test/checkpoint-restore-undoable.test.js — a checkpoint RESTORE is undoable and never destroys the
   Commander's own work.

   The bug (audit 09-22, Hermes parity): checkpoint-store restore() ran `git reset --hard <sha>` then
   `git clean -fd` with NO snapshot of the current state. A hand edit made after the last agent snapshot (v3) and a
   new untracked draft-by-commander.txt were destroyed and existed nowhere in the shadow history. Hermes takes a
   pre-rollback snapshot ("undo the undo").

   Proves against a REAL temp workspace + REAL git (the same harness shape as checkpoint-store.test.js):
     (1) restore records a labelled 'pre-restore' row in the agent's index, and restoreDetailed names it;
     (2) restoring THAT id brings back the hand edit AND the untracked file, byte-exact — and is itself undoable;
     (3) ignored files follow the snapshot path's own ignore rules: never snapshotted, never removed;
     (4) the undo point is recorded even when nothing changed (an explicit row, not a silent dedup);
     (5) a pre-restore snapshot failure (commit fails / add fails / index cannot be persisted) REFUSES the restore
         and leaves every file untouched;
     (6) the existing refusal rules hold (unknown id, bad agentId) and take no snapshot. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');

function runGit(args, opts) {
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}
// a runGit that fails the FIRST git call whose argv contains `verb` once armed
function failingGit(verb) {
  const state = { armed: false, hits: 0 };
  const fn = (args, opts) => {
    if (state.armed && args.indexOf(verb) >= 0) { state.hits++; return Promise.resolve({ code: 1, stdout: '', stderr: 'simulated ' + verb + ' failure' }); }
    return runGit(args, opts);
  };
  return { fn, state };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-undo-'));
  const clock = makeClock(1700000000000);
  const aid = 'u1';
  const wt = path.join(root, aid);
  fs.mkdirSync(wt, { recursive: true });
  const P = (rel) => path.join(wt, rel);
  const write = (rel, body) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), body); };
  const read = (rel) => fs.readFileSync(P(rel), 'utf8');
  const exists = (rel) => fs.existsSync(P(rel));
  const store = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 50 });
  const rows = () => store.list(aid).snapshots;

  try {
    // ---- baseline: v1 + an ignore rule (tracked) ----
    write('.gitignore', '*.log\n');
    write('notes.md', 'v1\n');
    const s1 = await store.snapshot(aid, { runId: 'r1', turn: 0, label: 'fs.write' });
    A.ok(s1 && s1.created, 'baseline snapshot created');
    // the agent edits -> v2 snapshot
    write('notes.md', 'v2 by agent\n');
    const s2 = await store.snapshot(aid, { runId: 'r1', turn: 1, label: 'fs.edit' });
    A.ok(s2 && s2.created && s2.id !== s1.id, 'agent snapshot v2 created');
    // the Commander's OWN work after the last snapshot: a hand edit, a new untracked file (nested), an ignored file
    write('notes.md', 'v3 hand edit by the commander\r\nwith CRLF bytes\n');
    write('drafts/draft-by-commander.txt', 'my own draft — never snapshotted by any agent\n');
    write('scratch.log', 'ignored scratch\n');
    const before = rows().length;

    // ---- (1) restore to the baseline records a labelled pre-restore row and names it ----
    const out = await store.restoreDetailed(aid, s1.id);
    A.ok(out && out.ok === true, '(1) restore to the baseline succeeded');
    A.ok(out.preRestoreId && store.isValidId(out.preRestoreId), '(1) restoreDetailed returns the pre-restore snapshot id');
    A.eq(rows().length, before + 1, '(1) exactly one new index row');
    const pre = rows().find(s => s.id === out.preRestoreId);
    A.ok(pre && /^pre-restore/.test(pre.label), '(1) the new row is labelled pre-restore (' + (pre && pre.label) + ')');
    A.ok(pre && pre.gitCommit === out.preRestoreId, '(1) the row binds to its real shadow-git commit');
    A.eq(read('notes.md'), 'v1\n', '(1) the tracked file is back at v1');
    A.ok(!exists('drafts/draft-by-commander.txt'), '(1) the post-snapshot untracked file was removed by the rewind');

    // ---- (3) ignore rules: the ignored file was neither snapshotted nor removed ----
    A.eq(read('scratch.log'), 'ignored scratch\n', '(3) an ignored file survives the rewind (a rewind runs no clean)');
    const tree = execFileSync('git', ['--git-dir', path.join(root, '.checkpoints', aid, 'git'), 'ls-tree', '-r', '--name-only', out.preRestoreId], { encoding: 'utf8', windowsHide: true });
    A.ok(tree.split('\n').indexOf('drafts/draft-by-commander.txt') >= 0, '(3) the untracked non-ignored file IS in the pre-restore snapshot');
    A.ok(tree.split('\n').indexOf('scratch.log') < 0, '(3) the ignored file is NOT in it (same ignore rules as every snapshot)');

    // ---- (2) restoring the pre-restore id undoes the rewind, byte-exact ----
    const undo = await store.restoreDetailed(aid, out.preRestoreId);
    A.ok(undo && undo.ok === true, '(2) restoring the pre-restore snapshot succeeded');
    A.eq(read('notes.md'), 'v3 hand edit by the commander\r\nwith CRLF bytes\n', '(2) the Commander\'s hand edit is back, byte-exact (CRLF intact)');
    A.eq(read('drafts/draft-by-commander.txt'), 'my own draft — never snapshotted by any agent\n', '(2) the untracked draft is back, byte-exact');
    A.ok(undo.preRestoreId && undo.preRestoreId !== out.preRestoreId, '(2) the undo itself recorded its own pre-restore point');
    const redo = await store.restoreDetailed(aid, undo.preRestoreId);
    A.ok(redo.ok && read('notes.md') === 'v1\n' && !exists('drafts/draft-by-commander.txt'), '(2) and undoing the undo returns to the rewound state');
    A.ok((await store.restoreDetailed(aid, redo.preRestoreId)).ok && /v3 hand edit/.test(read('notes.md')), '(2) the chain stays undoable');

    // ---- (4) nothing changed since the head: the undo point is still an explicit, restorable row ----
    const n0 = rows().length;
    const same = await store.restoreDetailed(aid, s2.id);            // tree currently == last pre-restore content
    A.ok(same.ok, '(4) restore succeeded');
    const again = await store.restoreDetailed(aid, s2.id);           // restoring onto an identical tree
    A.ok(again.ok && again.preRestoreId, '(4) a no-change restore still records an undo point');
    A.eq(rows().length, n0 + 2, '(4) one explicit pre-restore row per restore (no silent dedup)');
    A.eq(read('notes.md'), 'v2 by agent\n', '(4) the tree is at v2');

    // ---- (5) pre-restore snapshot FAILURE refuses the restore; nothing is touched ----
    write('notes.md', 'v4 unsaved hand edit\n');
    write('drafts/second-draft.txt', 'second draft\n');
    for (const verb of ['commit', 'add']) {
      const g = failingGit(verb);
      const broken = makeCheckpointStore({ fs, pathMod: path, root, runGit: g.fn, clock, keep: 50 });
      const n1 = rows().length;
      g.state.armed = true;
      const r = await broken.restoreDetailed(aid, s1.id);
      A.eq(r.ok, false, '(5/' + verb + ') the restore is refused when the pre-restore ' + verb + ' fails');
      A.eq(r.reason, 'pre_restore_failed', '(5/' + verb + ') reason names the missing undo point');
      A.ok(g.state.hits >= 1, '(5/' + verb + ') the failure really was injected into the pre-restore snapshot');
      A.eq(await broken.restore(aid, s1.id), false, '(5/' + verb + ') the boolean restore() is refused too');
      A.eq(read('notes.md'), 'v4 unsaved hand edit\n', '(5/' + verb + ') the unsaved hand edit is untouched');
      A.eq(read('drafts/second-draft.txt'), 'second draft\n', '(5/' + verb + ') the untracked draft is untouched');
      A.eq(rows().length, n1, '(5/' + verb + ') no index row was added');
    }
    // the index cannot be persisted: the snapshot commit lands but is NOT a recorded restore point -> refuse
    const idxFs = Object.assign({}, fs, {
      renameSync: (from, to) => { if (/index\.json$/.test(String(to))) throw new Error('simulated index persist failure'); return fs.renameSync(from, to); },
      writeFileSync: (file, data, o) => { if (/index\.json(\.bak)?$/.test(String(file))) throw new Error('simulated index write failure'); return fs.writeFileSync(file, data, o); }
    });
    const noIndex = makeCheckpointStore({ fs: idxFs, pathMod: path, root, runGit, clock, keep: 50 });
    const r3 = await noIndex.restoreDetailed(aid, s1.id);
    A.eq(r3.ok, false, '(5/index) a pre-restore snapshot that cannot be recorded in the index refuses the restore');
    A.eq(r3.reason, 'pre_restore_failed', '(5/index) reason pre_restore_failed');
    A.eq(read('notes.md'), 'v4 unsaved hand edit\n', '(5/index) the hand edit is untouched');
    A.ok(exists('drafts/second-draft.txt'), '(5/index) the untracked draft is untouched');
    // and with a healthy store the same restore now works and preserves v4 as its undo point
    const ok4 = await store.restoreDetailed(aid, s1.id);
    A.ok(ok4.ok && read('notes.md') === 'v1\n', '(5) a healthy retry restores');
    A.ok((await store.restoreDetailed(aid, ok4.preRestoreId)).ok && read('notes.md') === 'v4 unsaved hand edit\n' && read('drafts/second-draft.txt') === 'second draft\n',
      '(5) the v4 edit + second draft come back from the retry\'s undo point');

    // ---- (6) existing refusal rules: no snapshot is taken for a refused id ----
    const n2 = rows().length;
    A.eq((await store.restoreDetailed(aid, 'not-a-real-sha-but-valid-chars')).reason, 'unknown', '(6) an unrecorded id is refused');
    A.eq(await store.restore('bad id!', s1.id), false, '(6) a bad agentId is refused');
    A.eq(rows().length, n2, '(6) refused restores record no pre-restore row');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('checkpoint-restore-undoable.test');
})().catch(e => { console.error(e); process.exit(1); });
