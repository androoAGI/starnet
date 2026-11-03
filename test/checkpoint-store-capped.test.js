/* node test/checkpoint-store-capped.test.js — the runner's OUTPUT LIMIT, with REAL git: a rewind's whole-change listings never
   depend on one capped call (lane checkpoint-links: review 6.2, final review 2, the minors review). The store runs Git through its
   own runner (sidecar/checkpoint-git.js) with a limit of 1500 bytes, so 120 files and 60 long names stand in for a captured
   node_modules and a flat folder of 150k-250k names at 8 MB. This was test/checkpoint-store.test.js's row 4c until undo review 12
   cut that file off at its 600 s through the HTTP gate's runner at 94% CPU (771 s run whole, row 4c about half of it): a step of its
   own now, in the same gate, moved as it stood, and both start Git without blocking (test/helpers/checkpoint-rows.js). Spawns git,
   so it rides test:http, as that file does. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
// the store's runner starts its Git as the lane's helper does (test/helpers/checkpoint-rows.js: no console host beside each Git)
const { launchSpawn } = require('./helpers/checkpoint-rows.js');

// every file below dir with its bytes, by path, sorted (as test/checkpoint-links.test.js's): a fixture's whole state, so a
// rename or a rewritten file that keeps the entry count still shows
function listing(dir) {
  const out = {};
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre ? pre + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else out[rel] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-capped-'));
  const clock = makeClock(1700000000000);

  try {
    // ---- 4c. the runner's OUTPUT LIMIT: a rewind's whole-change listings never depend on one capped call ----
    // sidecar/checkpoint-git.js answers { code:-1, truncated:true } once one call's output passes its limit (8 MB: about
    // 120k paths, a captured node_modules). This store runs Git through that very runner with a limit of CAP bytes, so 120
    // files stand in for that many. Before review 6.2 of lane checkpoint-links the rewind's one diff-index refused a rewind
    // to just before a big deletion, and its one diff-tree reported a rewind past a big install failed after its reset ran.
    {
      const CAP = 1500, capped = [];
      const cappedRunner = makeCheckpointGitRunner({ spawn: launchSpawn, maxBytes: CAP, clock: { now: () => Date.now() } });
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

    // ---- a declared slow step: these rewinds took test/checkpoint-store.test.js past test/slow.list's 40 s rule, and they pass it
    // alone under load (slow.list says what this step takes, under what load and when); listed there, a gate gives it 600 s ----
    {
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-store-capped.test.js'), 'this step is declared in test/slow.list (its rewinds run 120-file and 60-long-name fixtures through the capped runner)');
      A.eq([steps('http.list').includes('test/checkpoint-store-capped.test.js'), steps('fast.list').includes('test/checkpoint-store-capped.test.js')], [true, false], 'and a step of the HTTP gate, as test/checkpoint-store.test.js is');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('checkpoint-store-capped.test');
})().catch(e => { console.log('FAIL: checkpoint-store-capped.test threw — ' + (e && e.stack || e)); process.exit(1); });
