/* node test/checkpoint-store.test.js — the AMBIENT checkpoint edge (execution-spine Commit 1), with REAL git.

   Proves the shadow-git rollback net against a real temp workspace + real git + a FAKE clock: a snapshot
   captures the pre-mutation state, content-dedup avoids redundant commits, restore reverts an edited file
   BYTE-EXACT and removes files created after the snapshot, the index round-trips, the shadow git-dir lives
   OUTSIDE the agent's fs jail, and every guard (bad agentId / unknown snapshot / restore of an unrecorded id)
   fails closed. Spawns git, so it rides test:http (the subprocess bucket), not the fast unit gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');

// a real synchronous git runner (the test analogue of index.js's async execFile runner).
function runGit(args, opts) {
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}
// every file below dir with its bytes, by path, sorted (as test/checkpoint-links.test.js's): a fixture's whole state, so a
// rename or a rewritten file that keeps the entry count still shows
function listing(dir) {
  const out = {};
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre ? pre + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else out[rel] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-'));
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 5 });
  const aid = 'a1';
  const wt = path.join(root, aid);
  fs.mkdirSync(wt, { recursive: true });
  const write = (rel, body) => fs.writeFileSync(path.join(wt, rel), body);
  const read = (rel) => fs.readFileSync(path.join(wt, rel), 'utf8');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-project-'));

  try {
    // ---- 1. baseline snapshot of a non-empty workspace ----
    write('report.md', 'line one\nline two\n');
    const s1 = await store.snapshot(aid, { runId: 'r1', turn: 0, label: 'fs.write' });
    A.ok(s1 && s1.created, 'baseline snapshot created');
    A.ok(store.isValidId(s1.id), 'snapshot id is a valid git oid');
    A.ok(s1.files >= 1, 'measured at least one file');

    // ---- 2. content dedup: snapshot with NO change -> no new commit, same head ----
    const dup = await store.snapshot(aid, { runId: 'r1', turn: 1, label: 'fs.write' });
    A.ok(dup && dup.created === false, 'no-change snapshot is deduped (created:false)');
    A.eq(dup.id, s1.id, 'dedup returns the existing head id');

    // ---- 3. a real edit + a new file -> a fresh snapshot ----
    write('report.md', 'line one CHANGED\nline two\n');
    write('extra.txt', 'added after baseline\n');
    const s2 = await store.snapshot(aid, { runId: 'r1', turn: 2, label: 'fs.edit' });
    A.ok(s2 && s2.created, 'second snapshot created after a real change');
    A.ok(s2.id !== s1.id, 'a changed workspace yields a new snapshot id');

    // ---- 4. restore to the baseline: edited file reverts BYTE-EXACT + the new file is removed ----
    write('untracked-after-snapshot.txt', 'removed by the reset: the pre-restore capture took it\n');
    const gitCalls = [];
    const watchedStore = makeCheckpointStore({
      fs, pathMod: path, root, clock, keep: 5,
      runGit: (args, opts) => { gitCalls.push(args); return runGit(args, opts); }
    });
    const first = await watchedStore.restoreDetailed(aid, s1.id);
    A.eq(first.ok, true, 'restore to the baseline succeeds');
    // The pre-restore undo point (checkpoint-restore-undoable.test.js) commits the post-snapshot file BEFORE the
    // reset, so the reset itself removes it. A rewind runs no `git clean` (review round 5 of lane checkpoint-links:
    // all it could still delete was a file no capture took, such as an ignored .env, gone for good).
    A.ok(!gitCalls.some(a => a.indexOf('clean') >= 0), 'a rewind runs no git clean');
    A.ok(!fs.existsSync(path.join(wt, 'untracked-after-snapshot.txt')), 'the post-snapshot file was removed by the reset');
    A.ok(first.preRestoreId && store.list(aid).snapshots.some(s => s.id === first.preRestoreId),
      'it is in the recorded pre-restore undo point');
    A.ok(await store.restore(aid, first.preRestoreId), 'the undo point restores');
    A.ok(fs.existsSync(path.join(wt, 'untracked-after-snapshot.txt')),
      'the post-snapshot file is back from the undo point (the rewind lost nothing)');
    const ok = await store.restore(aid, s1.id);
    A.ok(ok, 'restore to baseline succeeded');
    A.eq(read('report.md'), 'line one\nline two\n', 'edited file reverted byte-exact');
    A.ok(!fs.existsSync(path.join(wt, 'extra.txt')), 'file created after the baseline was removed on restore');

    // ---- 4b. a file reset could not remove: an incomplete rewind, never ok ----
    // A file reset cannot unlink (another program holds it open without delete sharing) only gets a warning from Git,
    // which still exits 0. The runner here puts the file back right after the reset, as such a file stays: the rewind
    // must say it did not complete, name the file, and hand back its undo point (review round 6 of lane checkpoint-links:
    // with no clean left, nothing else noticed, and the route answered 200). Its own agent: `store` keeps 5 rows.
    {
      const aidS = 'st', wtS = path.join(root, aidS), later = path.join(wtS, 'later.txt');
      fs.mkdirSync(wtS, { recursive: true });
      fs.writeFileSync(path.join(wtS, 'base.txt'), 'v0\n');
      const b0 = await store.snapshot(aidS, { runId: 'r1', turn: 0, label: 'fs.write' });
      fs.writeFileSync(path.join(wtS, 'base.txt'), 'v1\n');
      fs.writeFileSync(later, 'made after the snapshot\n');
      const stuckStore = makeCheckpointStore({
        fs, pathMod: path, root, clock, keep: 5,
        runGit: async (args, opts) => {
          const r = await runGit(args, opts);
          if (args.indexOf('reset') >= 0) fs.writeFileSync(later, 'held open by another program\n');
          return r;
        }
      });
      const stuckR = await stuckStore.restoreDetailed(aidS, b0.id);
      A.eq(stuckR.ok, false, 'restore reports failure when reset could not remove a post-snapshot file');
      A.eq(stuckR.reason, 'git_failed', 'as an incomplete rewind');
      A.ok(/^"later\.txt", which the restore point lacks, could not be removed/.test(stuckR.detail || ''), 'naming the file (' + stuckR.detail + ')');
      A.eq(fs.readFileSync(path.join(wtS, 'base.txt'), 'utf8'), 'v0\n', 'the rest of the rewind was done');
      A.ok(stuckR.preRestoreId && store.list(aidS).snapshots.some(s => s.id === stuckR.preRestoreId),
        'with a recorded pre-restore undo point holding the post-snapshot file');
      A.ok(await store.restore(aidS, stuckR.preRestoreId), 'the undo point restores');
      A.eq(fs.readFileSync(later, 'utf8') + fs.readFileSync(path.join(wtS, 'base.txt'), 'utf8'), 'made after the snapshot\nv1\n',
        'the workspace is back as it was before the rewind (the incomplete rewind lost nothing)');
    }

    // ---- 4c. the runner's OUTPUT LIMIT: a rewind's whole-change listings never depend on one capped call ----
    // sidecar/checkpoint-git.js answers { code:-1, truncated:true } once one call's output passes its limit (8 MB: about
    // 120k paths, a captured node_modules). This store runs Git through that very runner with a limit of CAP bytes, so 120
    // files stand in for that many. Before review 6.2 of lane checkpoint-links the rewind's one diff-index refused a rewind
    // to just before a big deletion, and its one diff-tree reported a rewind past a big install failed after its reset ran.
    {
      const CAP = 1500, capped = [];
      const cappedRunner = makeCheckpointGitRunner({ spawn, maxBytes: CAP, clock: { now: () => Date.now() } });
      const capStore = makeCheckpointStore({
        fs, pathMod: path, root, clock, keep: 5,
        runGit: async (args, opts) => {
          const r = await cappedRunner(args, opts);
          if (r.truncated) capped.push(args.find(a => /^(diff-index|diff-tree|ls-files|ls-tree)$/.test(a)) || '?');
          return r;
        }
      });
      const install = (w) => { for (let i = 0; i < 120; i++) { const d = path.join(w, 'node_modules', 'pkg' + (i % 8), 'lib'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'file_' + i + '.js'), 'x' + i + '\n'); } };
      // a rewind to just before the agent deleted a big captured folder
      const wtD = path.join(root, 'cd');
      fs.mkdirSync(wtD, { recursive: true });
      fs.writeFileSync(path.join(wtD, 'app.js'), 'v0\n');
      install(wtD);
      const d0 = await capStore.snapshot('cd', { runId: 'r1', turn: 0, label: 'before rm -rf' });
      A.ok(d0 && d0.created && d0.files === 121, 'fixture: the 120 files are captured');
      fs.rmSync(path.join(wtD, 'node_modules'), { recursive: true });
      capped.length = 0;
      const rd = await capStore.restoreDetailed('cd', d0.id);
      A.eq(rd.ok, true, 'a rewind to just before a big deletion goes ahead (' + JSON.stringify(rd) + ')');
      A.ok(capped.indexOf('diff-index') >= 0, 'fixture: its whole diff-index listing passed the limit');
      const back = path.join(wtD, 'node_modules', 'pkg7', 'lib', 'file_119.js');
      A.eq(fs.existsSync(back) ? fs.readFileSync(back, 'utf8') : null, 'x119\n', 'and brings the deleted files back');
      // a rewind to before the agent installed a big folder
      const wtI = path.join(root, 'ci');
      fs.mkdirSync(wtI, { recursive: true });
      fs.writeFileSync(path.join(wtI, 'app.js'), 'v0\n');
      const i0 = await capStore.snapshot('ci', { runId: 'r1', turn: 0, label: 'before install' });
      install(wtI);
      await capStore.snapshot('ci', { runId: 'r1', turn: 1, label: 'after install' });
      capped.length = 0;
      const ri = await capStore.restoreDetailed('ci', i0.id);
      A.eq(ri.ok, true, 'a rewind past a big install completes and says so (' + JSON.stringify(ri) + ')');
      A.ok(capped.indexOf('diff-tree') >= 0, 'fixture: its whole diff-tree listing passed the limit');
      A.ok(!fs.existsSync(path.join(wtI, 'node_modules', 'pkg0', 'lib', 'file_0.js')), 'and the installed files are gone');
      A.ok(ri.preRestoreId && capStore.list('ci').snapshots.some(s => s.id === ri.preRestoreId), 'with its undo row recorded');
      // a rewind past a FLAT folder whose own entry list (ls-tree <tree>:<folder>, the last split) passes the limit: about
      // 150k-250k long names at 8 MB, 60 here. Before the minors review of lane checkpoint-links, reset ran first and only
      // then was the deletion listed: git_failed, the folder gone from disk, and every restore of its undo row (or of any
      // row holding the folder) refused, as that rewind's own write list overflowed the same way. What reset will remove
      // is now listed before the pre-restore commit: refused, no file in the workspace touched, no undo row, so nothing is
      // stranded. The refusal touches only the checkpoint's own store (its staging index and Git objects), never the person's
      // files: every path and every byte below the workspace is checked, with an edit and a new file no snapshot took.
      const wtF = path.join(root, 'cf'), flat = path.join(wtF, 'data');
      fs.mkdirSync(wtF, { recursive: true });
      fs.writeFileSync(path.join(wtF, 'app.js'), 'v0\n');
      const f0 = await capStore.snapshot('cf', { runId: 'r1', turn: 0, label: 'before the flat folder' });
      fs.mkdirSync(flat);
      const flatName = (i) => 'sample_' + String(i).padStart(4, '0') + '_with_a_long_descriptive_name.bin';
      for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(flat, flatName(i)), 'd' + i + '\n');
      fs.writeFileSync(path.join(wtF, 'app.js'), 'v1\n');
      const f1 = await capStore.snapshot('cf', { runId: 'r1', turn: 1, label: 'a flat folder of 60 long names' });
      A.ok(f0 && f0.created && f1 && f1.created && f1.files === 61, 'fixture: the flat folder\'s 60 files are captured');
      fs.writeFileSync(path.join(wtF, 'app.js'), 'v2\n');                       // the person's work since the last snapshot
      fs.writeFileSync(path.join(wtF, 'notes.txt'), 'no snapshot took this\n');
      const wantF = { 'app.js': 'v2\n' };
      for (let i = 0; i < 60; i++) wantF['data/' + flatName(i)] = 'd' + i + '\n';
      wantF['notes.txt'] = 'no snapshot took this\n';
      A.eq(listing(wtF), wantF, 'fixture: the workspace holds app.js, the 60 named files with their bytes, and notes.txt');
      const rowsF = capStore.list('cf').snapshots.length;
      capped.length = 0;
      const rf = await capStore.restoreDetailed('cf', f0.id);
      A.ok(capped.indexOf('ls-tree') >= 0, 'fixture: the folder\'s own entry list passed the limit (' + JSON.stringify(capped) + ')');
      A.eq([rf.ok, rf.reason], [false, 'uncaptured_check_failed'], 'a rewind past a folder whose entry list Git cannot give in one call is refused (' + JSON.stringify(rf) + ')');
      A.ok(/^Git could not list what rewinding would remove/.test(rf.detail || '') && !rf.preRestoreId, 'saying so, with no undo row');
      A.eq(capStore.list('cf').snapshots.length, rowsF, 'and no row added');
      A.eq(listing(wtF), wantF,
        'no file in the workspace was touched: the same 60 names in the flat folder with the same bytes, the edit and the new file where they were');

      // THE UNDO OF A COMPLETED REWIND, through the normal API (final review 2 of lane checkpoint-links). T0's .gitignore
      // lists node_modules; S1's does not, and S1 captured 120 files there beside a node_modules/debug.log both ignore; then
      // app.js was edited, no snapshot since. The rewind to T0 deletes the 120 files and keeps node_modules/ (debug.log),
      // which T0's .gitignore, now on disk, prunes. The undo's link check lists what the undo row holds in that folder
      // (ls-files --with-tree): in one capped call it refused the undo (link_check_failed), the 120 files and app.js v2 only
      // in the shadow repo, and every capture was skipped while the index tracked the folder below a rule pruning it
      const wtU = path.join(root, 'cu');
      fs.mkdirSync(wtU, { recursive: true });
      fs.writeFileSync(path.join(wtU, 'app.js'), 'v0\n');
      fs.writeFileSync(path.join(wtU, '.gitignore'), 'node_modules\n*.log\n');
      const u0 = await capStore.snapshot('cu', { runId: 'r1', turn: 0, label: 'node_modules ignored' });
      fs.writeFileSync(path.join(wtU, '.gitignore'), '*.log\n');
      install(wtU);
      fs.writeFileSync(path.join(wtU, 'node_modules', 'debug.log'), 'a log both .gitignore files ignore\n');
      fs.writeFileSync(path.join(wtU, 'app.js'), 'v1\n');
      const u1 = await capStore.snapshot('cu', { runId: 'r1', turn: 1, label: 'node_modules captured' });
      A.ok(u0 && u0.created && u1 && u1.created && u1.files === 122, 'fixture: the 120 files are captured, debug.log is not');
      fs.writeFileSync(path.join(wtU, 'app.js'), 'v2, no snapshot took this\n');
      const wantU = listing(wtU);
      A.eq(Object.keys(wantU).length, 123, 'fixture: .gitignore, app.js, debug.log and the 120 files');
      const ru = await capStore.restoreDetailed('cu', u0.id);
      A.eq(ru.ok, true, 'the rewind to the point that ignores node_modules completes (' + JSON.stringify(ru) + ')');
      A.eq(listing(wtU), { '.gitignore': 'node_modules\n*.log\n', 'app.js': 'v0\n', 'node_modules/debug.log': 'a log both .gitignore files ignore\n' },
        'removing the 120 captured files, keeping the log no capture took');
      capped.length = 0;
      const uu = await capStore.restoreDetailed('cu', ru.preRestoreId || '');
      A.ok(capped.indexOf('ls-files') >= 0, 'fixture: the link check\'s listing of node_modules passed the limit (' + JSON.stringify(capped) + ')');
      A.eq(uu.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(uu) + ')');
      A.eq(listing(wtU), wantU, 'and every path and byte is back: app.js v2, .gitignore, debug.log and the 120 files');
      // and a capture while the index tracks node_modules below a rule that prunes it
      fs.writeFileSync(path.join(wtU, '.gitignore'), 'node_modules\n*.log\n');
      fs.writeFileSync(path.join(wtU, 'app.js'), 'v3\n');
      capped.length = 0;
      const u3 = await capStore.snapshot('cu', { runId: 'r1', turn: 2, label: 'node_modules ignored again, still tracked' });
      A.ok(u3 && u3.created && capped.indexOf('ls-files') >= 0, 'a capture lists what the index tracks below the pruned folder past the limit, and is taken (' + JSON.stringify(capped) + ')');

      // the same class in the uncaptured check: the rewind turns a captured FILE x into the target's folder x/ of 120
      // files; its undo turns x/ back into the file, and lists the gitlinks x/ holds. One ls-files -s call over the folder
      // passed the limit and refused the undo (uncaptured_check_failed), app.js v2 and the file x only in the shadow repo
      const wtX = path.join(root, 'cx');
      fs.mkdirSync(wtX, { recursive: true });
      fs.writeFileSync(path.join(wtX, 'app.js'), 'v0\n');
      install(wtX);
      fs.renameSync(path.join(wtX, 'node_modules'), path.join(wtX, 'x'));
      const x0 = await capStore.snapshot('cx', { runId: 'r1', turn: 0, label: 'x is a folder of 120 files' });
      fs.rmSync(path.join(wtX, 'x'), { recursive: true });
      fs.writeFileSync(path.join(wtX, 'x'), 'x is a file\n');
      fs.writeFileSync(path.join(wtX, 'app.js'), 'v1\n');
      const x1 = await capStore.snapshot('cx', { runId: 'r1', turn: 1, label: 'x is a file' });
      A.ok(x0 && x0.files === 121 && x1 && x1.created, 'fixture: x was a captured folder of 120 files, then a captured file');
      fs.writeFileSync(path.join(wtX, 'app.js'), 'v2, no snapshot took this\n');
      const wantX = listing(wtX);
      const rx = await capStore.restoreDetailed('cx', x0.id);
      A.eq([rx.ok, fs.statSync(path.join(wtX, 'x')).isDirectory()], [true, true], 'the rewind writes the folder x/ (' + JSON.stringify(rx) + ')');
      capped.length = 0;
      const ux = await capStore.restoreDetailed('cx', rx.preRestoreId || '');
      A.ok(capped.indexOf('ls-files') >= 0, 'fixture: the listing of what the index tracks in x/ passed the limit (' + JSON.stringify(capped) + ')');
      A.eq(ux.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(ux) + ')');
      A.eq(listing(wtX), wantX, 'and every path and byte is back: the file x and app.js v2, no x/ left');

      // where the split ends, a FLAT folder below a pruned one whose own entry list passes the limit (captured before the
      // .gitignore listed vendor): every listing of what is tracked there answers null, never a partial list. The capture is
      // skipped (health says so) and the rewind refused before anything is touched, no undo row
      const wtV = path.join(root, 'cv'), flatV = path.join(wtV, 'vendor', 'blobs');
      fs.mkdirSync(flatV, { recursive: true });
      fs.writeFileSync(path.join(wtV, 'app.js'), 'v0\n');
      const v0 = await capStore.snapshot('cv', { runId: 'r1', turn: 0, label: 'an empty vendor/blobs' });
      for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(flatV, flatName(i)), 'v' + i + '\n');
      const v1 = await capStore.snapshot('cv', { runId: 'r1', turn: 1, label: 'vendor/blobs of 60 long names' });
      A.ok(v0 && v1 && v1.created && v1.files === 61, 'fixture: the flat folder\'s 60 files are captured');
      fs.writeFileSync(path.join(wtV, '.gitignore'), 'vendor\n');
      fs.writeFileSync(path.join(wtV, 'app.js'), 'v2, no snapshot took this\n');
      capped.length = 0;
      A.eq(await capStore.snapshot('cv', { runId: 'r1', turn: 2, label: 'vendor ignored' }), null, 'a capture that cannot list what the index tracks below the pruned vendor is skipped');
      A.ok(capped.indexOf('ls-tree') >= 0, 'fixture: the flat folder\'s own entry list passed the limit (' + JSON.stringify(capped) + ')');
      A.ok(/could not be listed/.test(((capStore.health('cv') || {}).lastFailure || {}).reason || ''), 'and health says why');
      const wantV = listing(wtV), rowsV = capStore.list('cv').snapshots.length;
      const rv = await capStore.restoreDetailed('cv', v0.id);
      A.eq([rv.ok, rv.reason, !!rv.preRestoreId], [false, 'link_check_failed', false], 'a rewind that cannot list it is refused, with no undo row (' + JSON.stringify(rv) + ')');
      A.eq([capStore.list('cv').snapshots.length, listing(wtV)], [rowsV, wantV], 'and no row added, every path and byte in the workspace as it was');
    }

    // ---- 4d. the round 6 checks FAIL CLOSED: a listing they need that Git cannot give refuses the rewind, untouched ----
    // A runner that fails one Git verb (review 6.2 of lane checkpoint-links: each answer was pinned only by the route's
    // source regex): diff-index (what the rewind writes), check-ignore (is the file in the way ignored?) and diff-tree
    // (what reset will remove, listed before the pre-restore commit since the minors review) before anything is touched;
    // ls-files after the reset (does the index hold a file still there?), an incomplete rewind with its undo row, never ok.
    {
      const failing = (verb) => makeCheckpointStore({ fs, pathMod: path, root, clock, keep: 5,
        runGit: async (args, opts) => (args.indexOf(verb) >= 0 ? { code: 128, stdout: '', stderr: 'fatal: failed on purpose' } : runGit(args, opts)) });
      const fresh = (aidF) => { const w = path.join(root, aidF); fs.mkdirSync(w, { recursive: true }); return w; };
      const wA = fresh('fa');
      fs.writeFileSync(path.join(wA, 'a.txt'), 'v0\n');
      const a0 = await store.snapshot('fa', { runId: 'r1', turn: 0, label: 'fs.write' });
      fs.writeFileSync(path.join(wA, 'a.txt'), 'v1\n');
      fs.writeFileSync(path.join(wA, 'b.txt'), 'b\n');
      await store.snapshot('fa', { runId: 'r1', turn: 1, label: 'fs.write' });
      const rowsA = store.list('fa').snapshots.length;
      const rA = await failing('diff-index').restoreDetailed('fa', a0.id);
      A.eq(rA.reason, 'uncaptured_check_failed', 'a rewind whose write list Git cannot give is refused (' + JSON.stringify(rA) + ')');
      A.ok(/^Git could not list what rewinding would write/.test(rA.detail || '') && !rA.preRestoreId, 'saying so, with no undo row');
      A.eq([store.list('fa').snapshots.length, fs.readFileSync(path.join(wA, 'a.txt'), 'utf8')], [rowsA, 'v1\n'], 'nothing was touched');
      const wB = fresh('fb');
      fs.writeFileSync(path.join(wB, '.env'), 'A\n');
      const b0 = await store.snapshot('fb', { runId: 'r1', turn: 0, label: 'fs.write' });
      fs.unlinkSync(path.join(wB, '.env'));
      await store.snapshot('fb', { runId: 'r1', turn: 1, label: 'fs.write' });
      fs.writeFileSync(path.join(wB, '.env'), 'B, no capture yet\n');
      const rowsB = store.list('fb').snapshots.length;
      const rB = await failing('check-ignore').restoreDetailed('fb', b0.id);
      A.eq(rB.reason, 'uncaptured_check_failed', 'a rewind that cannot ask Git whether the file in its way is ignored is refused (' + JSON.stringify(rB) + ')');
      A.ok(/^Git could not say which files it ignores/.test(rB.detail || '') && !rB.preRestoreId, 'saying so, with no undo row');
      A.eq([store.list('fb').snapshots.length, fs.readFileSync(path.join(wB, '.env'), 'utf8')], [rowsB, 'B, no capture yet\n'], 'nothing was touched');
      const wC = fresh('fc');
      fs.writeFileSync(path.join(wC, 'a.txt'), 'v0\n');
      const c0 = await store.snapshot('fc', { runId: 'r1', turn: 0, label: 'fs.write' });
      fs.writeFileSync(path.join(wC, 'a.txt'), 'v1\n');
      fs.writeFileSync(path.join(wC, 'later.txt'), 'made after the snapshot\n');
      const rowsC = store.list('fc').snapshots.length;
      const rC = await failing('diff-tree').restoreDetailed('fc', c0.id);
      A.eq(rC.reason, 'uncaptured_check_failed', 'a rewind whose remove list Git cannot give is refused (' + JSON.stringify(rC) + ')');
      A.ok(/^Git could not list what rewinding would remove/.test(rC.detail || '') && !rC.preRestoreId, 'saying so, with no undo row');
      A.eq([store.list('fc').snapshots.length, fs.readFileSync(path.join(wC, 'a.txt'), 'utf8'), fs.existsSync(path.join(wC, 'later.txt'))], [rowsC, 'v1\n', true],
        'nothing was touched');
      const wD = fresh('fd'), stuck = path.join(wD, 'later.txt');
      fs.writeFileSync(path.join(wD, 'a.txt'), 'v0\n');
      const e0 = await store.snapshot('fd', { runId: 'r1', turn: 0, label: 'fs.write' });
      fs.writeFileSync(path.join(wD, 'a.txt'), 'v1\n');
      fs.writeFileSync(stuck, 'made after the snapshot\n');
      let resetRan = false;
      const afterReset = makeCheckpointStore({ fs, pathMod: path, root, clock, keep: 5,
        runGit: async (args, opts) => {
          if (resetRan && args.indexOf('ls-files') >= 0) return { code: 128, stdout: '', stderr: 'fatal: failed on purpose' };
          const r = await runGit(args, opts);
          if (args.indexOf('reset') >= 0) { resetRan = true; fs.writeFileSync(stuck, 'held open by another program\n'); }
          return r;
        } });
      const rD = await afterReset.restoreDetailed('fd', e0.id);
      A.eq([rD.ok, rD.reason], [false, 'git_failed'], 'a rewind that cannot check a file reset left is not ok (' + JSON.stringify(rD) + ')');
      A.ok(/^the rewind ran, but Git could not check that the files it was to remove are gone/.test(rD.detail || ''), 'and says the rewind ran');
      A.ok(rD.preRestoreId && store.list('fd').snapshots.some(s => s.id === rD.preRestoreId), 'with its undo row recorded');
      A.eq(fs.readFileSync(path.join(wD, 'a.txt'), 'utf8'), 'v0\n', 'the reset itself ran');
      A.ok(await store.restore('fd', rD.preRestoreId), 'and the undo row restores');
      A.eq(fs.readFileSync(path.join(wD, 'a.txt'), 'utf8') + fs.readFileSync(stuck, 'utf8'), 'v1\nmade after the snapshot\n', 'the workspace is back as it was');
    }

    // ---- 5. the index round-trips + records both real snapshots (lineage threaded) ----
    const idx = store.list(aid);
    A.ok(idx.snapshots.length >= 2, 'index records both snapshots');
    A.ok(idx.snapshots.some(s => s.id === s1.id) && idx.snapshots.some(s => s.id === s2.id), 'both ids present in the index');

    // ---- 6. jail isolation: the shadow git-dir is OUTSIDE the agent work-tree ----
    const gitDir = path.join(root, '.checkpoints', aid, 'git');
    A.ok(fs.existsSync(path.join(gitDir, 'HEAD')), 'shadow repo exists');
    A.ok(gitDir.indexOf(path.join(root, aid) + path.sep) !== 0, 'git-dir is NOT inside the agent fs jail');

    // ---- 7. guards fail closed ----
    A.eq(await store.snapshot('bad id!', {}), null, 'snapshot rejects a bad agentId');
    A.eq(await store.restore(aid, 'not-a-real-sha-but-valid-chars'), false, 'restore refuses an id not in the index');
    A.eq(await store.restore('bad id!', s1.id), false, 'restore rejects a bad agentId');

    // ---- 7b. EXTERNAL PROJECT ROOT: isolated history, exact-root identity, revocation-safe restore ----
    let projectAllowed = true;
    const scoped = makeCheckpointStore({
      fs, pathMod: path, root, runGit, clock, keep: 20,
      scopeIdOf: () => '0123456789abcdef01234567',
      allowWorkTree: (candidate) => projectAllowed && path.resolve(candidate) === path.resolve(project)
    });
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
    fs.writeFileSync(path.join(project, '.git', 'STARNET_TEST_MARKER'), 'user repo metadata\n');
    fs.writeFileSync(path.join(project, 'project.txt'), 'project baseline\n');
    const ps1 = await scoped.snapshot('pr', { runId: 'external', turn: 0, label: 'shell.exec', workTree: project, authorizedWorkTree: true });
    A.ok(ps1 && ps1.created, 'external project baseline snapshot created');
    A.ok(/^0123456789abcdef01234567:/.test(ps1.id), 'external snapshot id is bound to its root scope');
    fs.writeFileSync(path.join(project, 'project.txt'), 'project changed\n');
    fs.writeFileSync(path.join(project, 'new.txt'), 'created later\n');
    projectAllowed = false;
    A.eq(scoped.list('pr').snapshots.find(s => s.id === ps1.id).restoreAvailable, false, 'revoked project checkpoint is listed but truthfully unavailable');
    A.eq(await scoped.restore('pr', ps1.id), false, 'restore fails closed after the project grant is revoked');
    A.eq(fs.readFileSync(path.join(project, 'project.txt'), 'utf8'), 'project changed\n', 'revoked restore did not touch project bytes');
    projectAllowed = true;
    A.eq(scoped.list('pr').snapshots.find(s => s.id === ps1.id).restoreAvailable, true, 're-authorizing the exact root makes its restore point available again');
    A.ok(await scoped.restore('pr', ps1.id), 're-authorized external project restore succeeds');
    A.eq(fs.readFileSync(path.join(project, 'project.txt'), 'utf8'), 'project baseline\n', 'external project bytes restore exactly');
    A.ok(!fs.existsSync(path.join(project, 'new.txt')), 'external project restore removes files created after the snapshot');
    A.eq(fs.readFileSync(path.join(project, '.git', 'STARNET_TEST_MARKER'), 'utf8'), 'user repo metadata\n', 'shadow restore never reads, resets, or cleans the project\'s own .git metadata');
    const projectIndex = path.join(root, '.checkpoints', 'pr', 'index.json');
    fs.rmSync(projectIndex, { force: true }); fs.rmSync(projectIndex + '.bak', { force: true });
    projectAllowed = false;
    const rebuiltProject = await scoped.listResilient('pr');
    A.eq(rebuiltProject.snapshots.find(s => s.id === ps1.id).restoreAvailable, false,
      'index-loss rebuild preserves revoked project history as visible but unavailable');
    projectAllowed = true;
    const projectRecord = scoped.list('pr').snapshots.find(s => s.id === ps1.id);
    A.eq(projectRecord.workTree, fs.realpathSync(project), 'index identifies the exact project root affected');
    A.eq(projectRecord.gitCommit, ps1.id.split(':')[1], 'index binds the scoped id to its real git commit');
    const projectGit = path.join(root, '.checkpoints', 'pr', 'roots', '0123456789abcdef01234567', 'git');
    A.ok(fs.existsSync(path.join(projectGit, 'HEAD')), 'project history is isolated outside both project and agent jail');

    // ---- 8. prune keeps the cap (keep:5) ----
    for (let i = 0; i < 8; i++) { write('report.md', 'rev ' + i + '\n'); await store.snapshot(aid, { runId: 'r1', turn: 10 + i, label: 'fs.write' }); }
    A.ok(store.list(aid).snapshots.length <= 5, 'index pruned to the keep cap');

    // ---- 9. index durability: a .bak snapshot is written; a torn (zero-length) index recovers sync from .bak ----
    const idxFile = path.join(root, '.checkpoints', aid, 'index.json');
    A.ok(fs.existsSync(idxFile + '.bak'), 'saveIndex wrote a .bak last-known-good snapshot');
    const beforeTorn = store.list(aid).snapshots.length;
    fs.writeFileSync(idxFile, '');                                    // simulate a torn index write
    A.eq(store.list(aid).snapshots.length, beforeTorn, 'a torn (zero-length) index recovers from .bak (sync list)');

    // ---- 10. REBUILD from git: wipe BOTH index.json and its .bak; the commits are the truth ----
    fs.rmSync(idxFile, { force: true });
    fs.rmSync(idxFile + '.bak', { force: true });
    A.eq(store.list(aid).snapshots.length, 0, 'with index + .bak gone, the sync list is empty (git not consulted)');
    const rebuilt = await store.listResilient(aid);                  // async path rebuilds from git log
    A.ok(rebuilt.snapshots.length >= 5, 'listResilient rebuilt the index from the shadow-git commits');
    A.ok(rebuilt.snapshots.every(s => store.isValidId(s.id)), 'every rebuilt record has a valid git-oid id');
    A.ok(fs.existsSync(idxFile), 'the rebuilt index was re-persisted for fast subsequent reads');
    A.eq(store.list(aid).snapshots.length, rebuilt.snapshots.length, 'a subsequent sync list sees the re-persisted rebuild');
    // and a per-id restore works again off the rebuilt index (the commit is real)
    const targetId = rebuilt.snapshots[rebuilt.snapshots.length - 1].id;
    A.ok(await store.restore(aid, targetId), 'restore works against a rebuilt-from-git index');

    /* ---- 10b. the WRITE order a live run actually takes ------------------------------------------
       Case 10 covers the READ order: wipe both files, then list. A real mutating tool call SNAPSHOTS
       FIRST. snapshot() was async but used the SYNC loadIndex, which returns an EMPTY index when
       index.json and its .bak are both gone — so it recorded on top of nothing and persisted ONE entry.
       readIndexRaw then reports 'ok' forever, loadIndexResilient short-circuits and never reaches the
       git-log rebuild again, and restore() refuses every surviving commit: the rewind UI shows a single
       restore point while the Commander's real history sits intact on disk, unreachable. */
    const preCrashIds = rebuilt.snapshots.map(x => x.id);
    A.ok(preCrashIds.length >= 5, 'we have a real pre-crash history to lose');
    fs.rmSync(idxFile, { force: true });
    fs.rmSync(idxFile + '.bak', { force: true });
    write('report.md', 'edited again after the index loss\n');
    const afterCrash = await store.snapshot(aid, { runId: 'r-after', turn: 99, label: 'fs.write' });
    A.ok(afterCrash && afterCrash.id, 'the post-crash snapshot still commits');
    const idxAfter = await store.listResilient(aid);
    A.ok(idxAfter.snapshots.length > 1,
      'snapshot() REBUILT from git instead of collapsing the history to ONE entry (got ' + idxAfter.snapshots.length + ')');
    A.eq(idxAfter.snapshots.length, 5, 'the index is back at the keep cap, not at 1');
    /* The rebuild reads the SHADOW REPO, which holds more history than the pruned index did, so the exact
       overlap with the previous window is not the invariant — these are: the newest pre-crash snapshot is
       still recorded, and the Commander can still roll back to one. Before the fix the index held exactly
       the post-crash entry and restore() refused every id above. */
    const survived = preCrashIds.filter(id => idxAfter.snapshots.some(x => x.id === id));
    A.ok(survived.length >= 1, 'pre-crash snapshots are still recorded (' + survived.length + ' of ' + preCrashIds.length + ' within the keep cap)');
    A.ok(idxAfter.snapshots.some(x => x.id === preCrashIds[preCrashIds.length - 1]),
      'the NEWEST pre-crash snapshot specifically survived the post-crash write');
    A.ok(await store.restore(aid, survived[survived.length - 1]),
      'and the Commander can still roll back to a pre-crash snapshot');

    // ---- 11. SIZE CEILING: a tiny threshold forces a sweep; the repo shrinks and stays restorable ----
    const aid2 = 'sz';
    const wt2 = path.join(root, aid2);
    fs.mkdirSync(wt2, { recursive: true });
    // 1-byte ceiling => any repo trips it. A store dedicated to this agent with the tiny cap.
    const tiny = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 5, maxRepoBytes: 1 });
    for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(wt2, 'f.txt'), 'v' + i + '\n'.repeat(1000)); await tiny.snapshot(aid2, { runId: 'r', turn: i, label: 'fs.write' }); }
    const gitDir2 = path.join(root, '.checkpoints', aid2, 'git');
    A.ok(fs.existsSync(path.join(gitDir2, 'HEAD')), 'repo still present after ceiling sweeps');
    // the last snapshot (post-sweep) is in the index and restorable — the store stays functional under the ceiling
    const idx2 = tiny.list(aid2);
    A.ok(idx2.snapshots.length >= 1, 'index still holds at least the post-sweep baseline');
    const last2 = idx2.snapshots[idx2.snapshots.length - 1].id;
    A.ok(await tiny.restore(aid2, last2), 'restore works after a size-ceiling re-init');
    // an explicit enforce call reports it swept (repo is > 1 byte)
    const rep = await tiny.enforceSizeCeiling(aid2);
    A.ok(rep.swept, 'enforceSizeCeiling reports a sweep when over the ceiling');
    // a huge ceiling is a no-op
    const big = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 5, maxRepoBytes: 1 << 30 });
    const rep2 = await big.enforceSizeCeiling(aid2);
    A.eq(rep2.swept, false, 'a repo under the ceiling is left untouched (no sweep)');
    // ---- TRANSIENT-UNREADABLE INDEX: an EBUSY read must NEVER trigger the lossy git rebuild ----
    // The rebuild reconstructs from `git log`, where runId/turn are unrecoverable (come back ''/0), and it
    // RE-PERSISTS over the index. Conflating a transient errno (AV/backup lock, EMFILE) with "absent"
    // therefore permanently killed rollback-by-run the moment one read hiccuped. An unreadable index now
    // serves .bak/empty for the pass and leaves the good file alone.
    {
      const indexFile = path.join(root, '.checkpoints', aid, 'index.json');
      const goodBytes = fs.readFileSync(indexFile, 'utf8');
      A.ok(goodBytes.length > 2, 'fixture: a real non-empty index exists on disk');
      const busyFs = Object.assign({}, fs, {
        readFileSync(p, enc) {
          if (String(p) === indexFile || String(p) === indexFile + '.bak') { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e; }
          return fs.readFileSync(p, enc);
        }
      });
      const busyStore = makeCheckpointStore({ fs: busyFs, pathMod: path, root, runGit, clock, keep: 5 });
      const listed = await busyStore.listResilient(aid);
      A.eq((listed.snapshots || []).length, 0, 'an unreadable index serves EMPTY for the pass (fail-closed), not a rebuild');
      const after = fs.readFileSync(indexFile, 'utf8');
      A.eq(after, goodBytes, 'the good index file was NOT overwritten by the lossy git rebuild');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('checkpoint-store.test');
})().catch(e => { console.log('FAIL: checkpoint-store.test threw — ' + (e && e.stack || e)); process.exit(1); });
