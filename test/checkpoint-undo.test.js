/* node test/checkpoint-undo.test.js — a completed rewind's undo row restores through restoreDetailed, every path and byte,
   or the rewind is refused with no file touched and no undo row (lane checkpoint-links, undo review 1, 2026-10-30;
   sidecar/checkpoint-store.js, restore's THE UNDO ROW RESTORES THROUGH THIS API). The lane's own rows of the same law are
   test/checkpoint-links.test.js row 20 (fr1-fr6) and test/checkpoint-store.test.js row 4c.

   The undo of a rewind is itself a rewind, to the undo row, from the tree the rewind left: its checks run under other
   .gitignore files, with another index, on another tree, and a check the rewind passed can still fail for it. Undo
   review 1 of the lane found, at a009067e (8808d408's undo closure):
     G1    the undo read its row's changed .gitignore files in one git grep call: past the runner's output limit it
           answered false and the undo was refused (link_check_failed), a read the rewind never took (8808d408);
     G2 G3 git grep -I skipped a .gitignore Git takes for binary (a NUL byte, a .gitattributes `-diff`), so the undo
           dropped its row's node_modules rule and walked that folder: past the walk's budget refused, within it its
           capture took the untracked files there and its reset deleted them (8808d408);
     R2 Ra P1 P2  the undo listed what lies below a folder it prunes (one the reset made: gen, big/sub/node_modules; or
           a link's folder) by a split that went down from the root through the whole entry list of a flat folder of
           long names above it, which no call of its rewind had listed: refused (link_check_failed; 2d1c2fb9 the same);
     N K   a folder the undo row's .gitignore names that the walk could not prune (a double-star bracket negation beside
           the rule, or the rule in another case where the file system folds case) was walked by the undo, whose capture
           took its untracked files and whose reset deleted them (2d1c2fb9 the same);
     P3 P3b a folder of files no capture took where the target holds a FILE, while the shadow index still holds that path
           as a file: `ls-files -o -i --directory` printed nothing for it, and reset deleted the folder, ok:true (P3
           through a folder only the target's .gitignore lists, a regression of 8808d408; P3b through the person's own
           rule, 2d1c2fb9 the same);
     W     a rewind to a point an older store or a bigger budget recorded wrote more files than the walk allows, or
           deeper: the rewind's own walk was small, and its undo's walk of what the reset wrote was refused (found with
           the review's fixes; 2d1c2fb9 the same).
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The runner's output limit is modelled as in test/checkpoint-store.test.js row 4c: the real runner capped at
   1500 bytes, so tens of long names stand in for the 150k-250k a flat folder needs at 8 MB, and the walk's budget is
   lowered the same way. Every row runs against a real temp work tree and real git. Fixtures: one junction (Windows) or
   directory symlink (POSIX), made inside this test's own os.tmpdir() folder and pointing only at a sibling folder it
   made; removed with `cmd /c rmdir` (Windows) / unlink before the folder is deleted. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';
function runGit(args, opts) {
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-undo-')));
const ROOT = path.join(BASE, 'ws');
const links = [];
function link(target, at) {
  if (path.relative(BASE, target).startsWith('..')) throw new Error('fixture link target outside the test folder');
  fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');
  links.push(at);
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
function unlinkLink(at) {
  if (!isWin) fs.unlinkSync(at);
  else {
    try { execFileSync('cmd', ['/c', 'rmdir', at], { windowsHide: true, stdio: 'ignore' }); }   // a junction: removed, never followed
    catch (e) { if (isLink(at)) fs.unlinkSync(at); else throw e; }
  }
  const i = links.indexOf(at); if (i >= 0) links.splice(i, 1);
}
function put(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
// every file below dir with its bytes, by path, sorted; a link is shown as one, never entered
function listing(dir) {
  const out = {};
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? pre + '/' + e.name : e.name;
      if (e.isSymbolicLink() || isLink(path.join(d, e.name))) out[rel] = '<link>';
      else if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out[rel] = fs.readFileSync(path.join(d, e.name), 'latin1');
    }
  };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}
const gitDirOf = (aid) => path.join(ROOT, '.checkpoints', aid, 'git');
function tree(aid, id) {
  return execFileSync('git', ['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', String(id).split(':').pop()], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
const flatName = (i) => 'sample_' + String(i).padStart(4, '0') + '_with_a_long_descriptive_name.bin';
const install = (dir, n, name) => { for (let i = 0; i < n; i++) put(path.join(dir, 'pkg' + (i % 8), 'lib', (name || 'f') + i + '.js'), 'x' + i + '\n'); };

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  const budget = (n) => makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: n });
  // the real runner, its output limit 1500 bytes; `cut` names the Git verbs it cut off since it was last emptied
  const cut = [];
  const cappedRunner = makeCheckpointGitRunner({ spawn, maxBytes: 1500, clock: { now: () => Date.now() } });
  const verbOf = (args) => args.find((a) => /^(diff-index|diff-tree|ls-files|ls-tree|grep|cat-file|check-ignore)$/.test(a)) || '?';
  const capped = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
    runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });

  // the rewind, then restoreDetailed(its preRestoreId): every path and byte back
  const twoCalls = async (st, aid, wt, targetId, label) => {
    const before = listing(wt);
    const r = await st.restoreDetailed(aid, targetId);
    A.eq(r && r.ok, true, label + ': the rewind goes ahead (' + JSON.stringify(r) + ')');
    const mid = listing(wt);
    cut.length = 0;
    const u = await st.restoreDetailed(aid, (r && r.preRestoreId) || '');
    A.eq(u && u.ok, true, label + ': restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(u) + ')');
    A.eq(listing(wt), before, label + ': and every path and byte is back');
    return { r: r, mid: mid, u: u, undoCut: cut.slice() };
  };
  // refused, with no undo row, every path and byte as it was
  const refusedClean = async (st, aid, wt, targetId, reason, detailRe, label) => {
    const before = listing(wt), rows = st.list(aid).snapshots.length;
    const r = await st.restoreDetailed(aid, targetId);
    A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId)], [false, reason, false], label + ' is refused, with no undo row (' + JSON.stringify(r) + ')');
    A.ok(detailRe.test((r && r.detail) || ''), label + ': saying why (' + JSON.stringify(r && r.detail) + ')');
    A.eq([st.list(aid).snapshots.length, listing(wt)], [rows, before], label + ': no row added, every path and byte in the workspace as it was');
    return r;
  };
  const nodeModulesIn = (aid, id) => tree(aid, id).filter((p) => /^node_modules\//i.test(p)).length;

  try {
    // ================= G1: the undo reads its row's changed .gitignore files =================
    {
      // G1a: S1's .gitignore (31 lines) and sub/.gitignore, the undo row's, differ from T0's. Their lines with git grep's
      // "<sha>:<path>" prefix pass the limit, their bytes do not. The undo read them in one grep call and was refused
      // (link_check_failed); now a batch past the limit is read in halves, and one file by its bytes alone (cat-file)
      const aid = 'g1a', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      const t0 = await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: a small .gitignore' });
      const lines = Array.from({ length: 30 }, (_, i) => 'generated_output_folder_' + String(i).padStart(3, '0') + '/').join('\n') + '\nnode_modules\n';
      put(path.join(wt, '.gitignore'), lines);
      put(path.join(wt, 'sub', '.gitignore'), 'dist\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      install(path.join(wt, 'node_modules'), 12);
      const s1 = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a longer .gitignore, node_modules ignored' });
      A.ok(!!(t0 && t0.created && s1 && s1.created) && lines.length < 1500 && tree(aid, s1.id).length === 3, 'fixture: S1\'s .gitignore is under the limit in bytes, and no capture took node_modules');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { u, undoCut } = await twoCalls(capped, aid, wt, t0.id, 'G1a, an undo whose row\'s .gitignore lines pass the limit with grep\'s prefix');
      A.ok(undoCut.includes('grep'), 'fixture: the undo\'s grep of them passed the limit (' + JSON.stringify(undoCut) + ')');
      A.eq(u && u.preRestoreId ? nodeModulesIn(aid, u.preRestoreId) : -1, 0, 'G1a: the undo read its row\'s node_modules rule, so its capture left node_modules out');
    }
    {
      // G1b: S1's .gitignore alone passes the limit (80 folder lines, 2.3 KB): no call can read it, so the undo could not
      // prune by it. The rewind is refused before anything is touched, as the undo's own read is taken before its commit
      const aid = 'g1b', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      const t0 = await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: a small .gitignore' });
      const big = Array.from({ length: 80 }, (_, i) => 'generated_output_folder_' + String(i).padStart(3, '0') + '/').join('\n') + '\nnode_modules\n';
      put(path.join(wt, '.gitignore'), big);
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a .gitignore past the limit' });
      A.ok(!!(t0 && t0.created && s1 && s1.created) && big.length > 1500, 'fixture: S1\'s .gitignore passes the limit in bytes (' + big.length + ')');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(capped, aid, wt, t0.id, 'link_check_failed', /^the \.gitignore files its undo would bring back could not be read/, 'G1b, a rewind whose undo could not read its row\'s .gitignore');
    }

    // ================= G2, G3: every .gitignore is read as text, whatever Git's binary detection says =================
    {
      // G2 (budget 60) and G2b (default budget): S1's .gitignore lists node_modules and holds a NUL byte, so grep -I took
      // it for binary and skipped it; Git and the walk still read its node_modules line. The undo dropped that rule and
      // walked node_modules: refused past the budget, within it its capture took the 70 files and its reset deleted them
      for (const [aid, max] of [['g2', 60], ['g2b', 0]]) {
        const st = max ? budget(max) : store;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'package.json'), '{}\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t0 = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
        put(path.join(wt, '.gitignore'), Buffer.from('node_modules\n\u0000\n', 'latin1'));
        put(path.join(wt, 'app.js'), 'v1\n');
        install(path.join(wt, 'node_modules'), 70);
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a .gitignore holding a NUL' });
        A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, 3], 'fixture (' + aid + '): no capture took node_modules');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { u } = await twoCalls(st, aid, wt, t0.id, aid + ', an undo whose row\'s .gitignore holds a NUL byte' + (max ? ' (budget ' + max + ')' : ''));
        A.eq(u && u.preRestoreId ? nodeModulesIn(aid, u.preRestoreId) : -1, 0, aid + ': the undo\'s capture left node_modules out');
      }
    }
    {
      // G3: a .gitattributes marking .gitignore -diff, in both rows (budget 60): grep -I skipped every .gitignore of both
      const st = budget(60);
      const aid = 'g3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, '.gitattributes'), '.gitignore -diff\n');
      put(path.join(wt, '.gitignore'), 'dist\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      const t0 = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: dist ignored' });
      put(path.join(wt, '.gitignore'), 'dist\nnode_modules\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      install(path.join(wt, 'node_modules'), 70);
      const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: node_modules ignored too' });
      A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, 4], 'fixture: no capture took node_modules');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await twoCalls(st, aid, wt, t0.id, 'g3, an undo whose row\'s .gitignore a .gitattributes marks -diff');
    }

    // ================= R2, Ra, P1, P2: a listing below a pruned folder never reads a whole folder above it =================
    {
      // R2: every snapshot and both restores through the capped runner. The root holds 60 long names; T's .gitignore
      // lists vendor and gen, which T still tracks; S1 has no gen, 12 other vendor files and no rule; app.js v3 since. The
      // undo prunes gen (the reset made it) and vendor, and listed them in one call past the limit, then from the root
      // down: the root's own entry list passed the limit too, a listing no call of the rewind took (link_check_failed)
      const aid = 'r2', wt = path.join(ROOT, aid);
      for (let i = 0; i < 60; i++) put(path.join(wt, flatName(i)), 'r' + i + '\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 12; i++) put(path.join(wt, 'vendor', 'a' + flatName(i).slice(0, 40)), 'a' + i + '\n');
      for (let i = 0; i < 12; i++) put(path.join(wt, 'gen', 'g' + flatName(i).slice(0, 40)), 'g' + i + '\n');
      const s0 = await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: all tracked' });
      put(path.join(wt, '.gitignore'), 'vendor\ngen\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'T: vendor and gen ignored, still tracked' });
      fs.rmSync(path.join(wt, 'gen'), { recursive: true });
      fs.rmSync(path.join(wt, 'vendor'), { recursive: true });
      for (let i = 0; i < 12; i++) put(path.join(wt, 'vendor', 'b' + flatName(i).slice(0, 40)), 'b' + i + '\n');
      put(path.join(wt, '.gitignore'), 'other\n');
      put(path.join(wt, 'app.js'), 'v2\n');
      const s1 = await capped.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no gen, other vendor files' });
      A.eq([s0 && s0.files, t && t.files, s1 && s1.created && s1.files], [85, 86, 74], 'fixture: every snapshot taken through the capped runner');
      put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
      const { undoCut } = await twoCalls(capped, aid, wt, t.id, 'R2, an undo pruning a folder the reset made, below a flat root');
      A.ok(undoCut.includes('ls-files'), 'fixture: the undo\'s listing of gen and vendor passed the limit (' + JSON.stringify(undoCut) + ')');
    }
    {
      // Ra: the same one folder down: a/ holds the 60 long names, a/vendor and a/gen (recorded by this file's runner,
      // which has no limit, as an older store or a bigger limit records them)
      const aid = 'ra', wt = path.join(ROOT, aid), a = path.join(wt, 'a');
      for (let i = 0; i < 60; i++) put(path.join(a, flatName(i)), 'r' + i + '\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 20; i++) put(path.join(a, 'vendor', 'v' + flatName(i).slice(0, 40)), 'v' + i + '\n');
      for (let i = 0; i < 20; i++) put(path.join(a, 'gen', 'g' + flatName(i).slice(0, 40)), 'g' + i + '\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: all tracked' });
      put(path.join(wt, '.gitignore'), 'vendor\ngen\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: vendor and gen ignored, still tracked' });
      fs.rmSync(path.join(a, 'gen'), { recursive: true });
      put(path.join(wt, '.gitignore'), 'vendor\n');
      put(path.join(wt, 'app.js'), 'v2\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no gen' });
      A.eq([t && t.files, s1 && s1.created && s1.files], [102, 82], 'fixture: T holds a/gen, S1 does not');
      put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
      const { undoCut } = await twoCalls(capped, aid, wt, t.id, 'Ra, an undo pruning a folder the reset made, below a flat folder above it');
      A.ok(undoCut.includes('ls-files'), 'fixture: the undo\'s listing of a/gen and a/vendor passed the limit (' + JSON.stringify(undoCut) + ')');
    }
    {
      // P1: T holds big/ (15 long names) and big/sub/node_modules (40 files), no rule; S1's .gitignore lists node_modules
      // and big/sub is gone; then 20 more long names in big/, app.js v2. The rewind writes big/sub/node_modules; its undo
      // prunes it (its row's rule) and split the listing down through big/, whose entry list in the undo row (35 names)
      // passes the limit, though not in the target or the old index (link_check_failed)
      const aid = 'p1', wt = path.join(ROOT, aid), big = path.join(wt, 'big');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 15; i++) put(path.join(big, flatName(i)), 'old' + i + '\n');
      install(path.join(big, 'sub', 'node_modules'), 40, 'file_');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'T: big/ and big/sub/node_modules, no rule' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      fs.rmSync(path.join(big, 'sub'), { recursive: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: node_modules ignored, big/sub gone' });
      A.eq([t && t.files, s1 && s1.created && s1.files], [56, 17], 'fixture: T holds big/sub/node_modules, S1 does not');
      for (let i = 15; i < 35; i++) put(path.join(big, flatName(i)), 'new' + i + ', no snapshot took this\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { undoCut } = await twoCalls(capped, aid, wt, t.id, 'P1, an undo pruning a folder the reset made, below a folder its row fills past the limit');
      A.ok(undoCut.includes('ls-files'), 'fixture: the undo\'s listing of big/sub/node_modules passed the limit (' + JSON.stringify(undoCut) + ')');
    }
    {
      // P2: T's .gitignore lists node_modules, which T still tracks (60 files); then 20 more long names in big/ (15 before)
      // and a junction big/linkdir to a sibling folder, app.js v1. The undo lists below the link and node_modules in one
      // call past the limit, and split it down through big/, 35 names in its row (link_check_failed)
      const aid = 'p2', wt = path.join(ROOT, aid), big = path.join(wt, 'big');
      const out = path.join(BASE, 'p2-outside');
      put(path.join(out, 'o.txt'), 'outside\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 15; i++) put(path.join(big, flatName(i)), 'old' + i + '\n');
      install(path.join(wt, 'node_modules'), 60);
      await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: node_modules captured' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'T: node_modules ignored, still tracked' });
      A.eq(t && t.files, 77, 'fixture: T tracks node_modules below its rule');
      for (let i = 15; i < 35; i++) put(path.join(big, flatName(i)), 'new' + i + ', no snapshot took this\n');
      link(out, path.join(big, 'linkdir'));
      put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
      const { r, undoCut } = await twoCalls(capped, aid, wt, t.id, 'P2, an undo listing below a link and a pruned folder');
      A.eq((r && r.links || []).map((l) => l.path), ['big/linkdir'], 'P2: the rewind left the link where it was, and said so');
      A.ok(undoCut.includes('ls-files'), 'fixture: the undo\'s listing passed the limit (' + JSON.stringify(undoCut) + ')');
      A.eq(listing(out), { 'o.txt': 'outside\n' }, 'P2: the folder behind the link is untouched');
    }

    // ================= P3: a folder of files no capture took where the target holds a FILE =================
    {
      // P3: T's .gitignore lists dist, T tracks dist/bundle (a FILE) and dist/keep.txt, and the index still holds them;
      // now the rule is *.log and dist/bundle is a folder of two new files no rule of the work tree ignores. dist is kept
      // out of the capture (only T's rule lists it); with --directory Git printed nothing for dist/bundle, so reset
      // deleted it with a.js and b.js, ok:true, in no row. They are taken by name now, and the undo brings them back
      const aid = 'p3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'bundle'), 'bundle v0\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'keep\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'dist/bundle a file' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: dist ignored, still tracked' });
      put(path.join(wt, '.gitignore'), '*.log\n');
      fs.unlinkSync(path.join(wt, 'dist', 'bundle'));
      put(path.join(wt, 'dist', 'bundle', 'a.js'), 'a, no capture took this\n');
      put(path.join(wt, 'dist', 'bundle', 'b.js'), 'b, no capture took this\n');
      put(path.join(wt, 'app.js'), 'v1, no capture took this\n');
      const { r, mid } = await twoCalls(store, aid, wt, t.id, 'P3, a rewind over a folder only the target\'s .gitignore lists');
      A.eq(mid['dist/bundle'], 'bundle v0\n', 'P3: the rewind wrote the target\'s file dist/bundle');
      A.eq(r && r.preRestoreId ? tree(aid, r.preRestoreId).filter((p) => /^dist\/bundle\//.test(p)) : [], ['dist/bundle/a.js', 'dist/bundle/b.js'], 'P3: the undo row holds a.js and b.js, taken by name');
    }
    {
      // P3b: the same through the person's own rule: T holds dist/bundle (a file); now .gitignore lists dist and
      // dist/bundle is a folder of two files it ignores. No capture can take them: refused, untouched
      const aid = 'p3b', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'bundle'), 'bundle v0\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: dist/bundle a file' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      fs.unlinkSync(path.join(wt, 'dist', 'bundle'));
      put(path.join(wt, 'dist', 'bundle', 'a.js'), 'a, ignored, no capture took this\n');
      put(path.join(wt, 'dist', 'bundle', 'b.js'), 'b, ignored, no capture took this\n');
      put(path.join(wt, 'app.js'), 'v1, no capture took this\n');
      A.ok(!!(t && t.created), 'fixture: T holds the file dist/bundle, and the index still does');
      const r = await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"dist\/bundle\/a\.js" as it is now is in no restore point \(Git ignores it\), inside the folder "dist\/bundle", which the restore point holds as a file/, 'P3b, a rewind over a folder of ignored files where the target holds a file');
      A.eq((r && r.paths || []).map((p) => p.path), ['dist/bundle/a.js', 'dist/bundle/b.js'], 'P3b: naming both files');
    }
    {
      // P3c: P3 with one of the two files ignored by the work tree's own *.log: that one refuses the rewind (no capture
      // takes it), though a.js alone would be taken by name
      const aid = 'p3c', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'bundle'), 'bundle v0\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'dist/bundle a file' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: dist ignored, still tracked' });
      put(path.join(wt, '.gitignore'), '*.log\n');
      fs.unlinkSync(path.join(wt, 'dist', 'bundle'));
      put(path.join(wt, 'dist', 'bundle', 'a.js'), 'a, no capture took this\n');
      put(path.join(wt, 'dist', 'bundle', 'debug.log'), 'a log the work tree ignores\n');
      await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"dist\/bundle\/debug\.log" as it is now is in no restore point \(Git ignores it\), inside the folder "dist\/bundle"/, 'P3c, a rewind over such a folder holding a file the work tree ignores');
    }
    {
      // P3d (capped): such a folder holding more of those files than one listing can name: the files it cannot name it
      // cannot take, so the rewind is refused, untouched
      const aid = 'p3d', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'bundle'), 'bundle v0\n');
      await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'dist/bundle a file' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'T: dist ignored, still tracked' });
      put(path.join(wt, '.gitignore'), '*.log\n');
      fs.unlinkSync(path.join(wt, 'dist', 'bundle'));
      for (let i = 0; i < 40; i++) put(path.join(wt, 'dist', 'bundle', flatName(i)), 'n' + i + '\n');
      cut.length = 0;
      await refusedClean(capped, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not list every file it ignores in a folder rewinding would replace/, 'P3d, a rewind over such a folder past the limit');
      A.ok(cut.includes('ls-files'), 'fixture: the listing of dist/bundle passed the limit (' + JSON.stringify(cut) + ')');
    }

    // ================= N, K: a folder the undo row's .gitignore names, that the walk could not prune =================
    {
      // N: two lines of github/gitignore's VisualStudio.gitignore, `node_modules/` and a double-star bracket negation of
      // a Packages build folder. The negation matched every folder to the walk, so neither walk pruned node_modules: the
      // rewind's capture left it out (Git ignores it), the undo's took its 70 files (no rule now) and its reset deleted them
      const aid = 'n', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
      put(path.join(wt, '.gitignore'), 'node_modules/\n!**/[Pp]ackages/build/\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      install(path.join(wt, 'node_modules'), 70);
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: node_modules ignored beside the negation' });
      A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, 3], 'fixture: Git ignores node_modules, no capture took it');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { u } = await twoCalls(store, aid, wt, t0.id, 'N, an undo whose row\'s rule sits beside a double-star bracket negation');
      A.eq(u && u.preRestoreId ? nodeModulesIn(aid, u.preRestoreId) : -1, 0, 'N: the undo\'s capture left node_modules out');
    }
    {
      // N control: a negation that does re-include node_modules (`!**/[Nn]ode_modules/`): Git reads it, so the walk must
      // enter it and find the junction there; pruned, Git would capture through the link
      const aid = 'nc', wt = path.join(ROOT, aid);
      const out = path.join(BASE, 'nc-outside');
      put(path.join(out, 'secret.txt'), 'OUTSIDE\n');
      put(path.join(wt, '.gitignore'), 'node_modules/\n!**/[Nn]ode_modules/\n');
      put(path.join(wt, 'node_modules', 'own.js'), 'own\n');
      link(out, path.join(wt, 'node_modules', 'jx'));
      const s = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'node_modules re-included, a junction in it' });
      A.eq(s && (s.links || []).map((l) => l.path), ['node_modules/jx'], 'N control: the walk entered the re-included node_modules and left its junction out');
      A.eq(s ? tree(aid, s.id) : [], ['.gitignore', 'node_modules/own.js'], 'N control: the capture holds node_modules\' own file and nothing from behind the junction');
    }
    if (foldsCase) {
      // K: S1's .gitignore spells the rule Node_modules; Git (core.ignorecase) ignores node_modules, the walk matched case
      // by case and walked it, and the undo's capture took its 70 files and its reset deleted them
      const aid = 'k', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
      put(path.join(wt, '.gitignore'), 'Node_modules\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      install(path.join(wt, 'node_modules'), 70);
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule in another case' });
      A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, 3], 'fixture: Git ignores node_modules, no capture took it');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { u } = await twoCalls(store, aid, wt, t0.id, 'K, an undo whose row\'s rule names node_modules in another case');
      A.eq(u && u.preRestoreId ? nodeModulesIn(aid, u.preRestoreId) : -1, 0, 'K: the undo\'s capture left node_modules out');
    } else console.log('[skip] K: this file system does not fold case');
    // ================= W: the undo's walk counts the tree the reset leaves =================
    {
      // W: T, recorded with the default budget (as an older store or a bigger budget records it), holds data/ of 60
      // files; S1 has none. Under a 40-entry budget the rewind walked a small tree and completed, and its undo's walk of
      // what the reset wrote passed the budget (link_check_failed). Refused before the commit now
      const st = budget(40);
      const aid = 'w', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 60; i++) put(path.join(wt, 'data', 'f' + i + '.txt'), 'd' + i + '\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 60 data files' });
      fs.rmSync(path.join(wt, 'data'), { recursive: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no data' });
      A.eq([t && t.files, s1 && s1.created && s1.files], [61, 1], 'fixture: T holds 60 data files, S1 none');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(st, aid, wt, t.id, 'link_check_failed', /^its undo would have to check more than 40 files and folders/, 'W, a rewind whose undo would walk past the budget');
      // the control: as many files written as removed (S2 holds 60 others) keeps the count, and the two calls go ahead
      for (let i = 0; i < 60; i++) put(path.join(wt, 'other', 'o' + i + '.txt'), 'o' + i + '\n');
      const wide = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: 60 other files' });
      A.ok(!!(wide && wide.created), 'fixture: S2 recorded with the default budget');
      const st80 = budget(80);
      await twoCalls(st80, aid, wt, t.id, 'W control, a rewind that writes as many files as it removes (budget 80)');
    }
    {
      // W depth: T, recorded with the default depth, holds a/b/c/d/e/f/g.txt (folders 6 deep); a store walking 5 levels
      // rewinds from a tree without a/: the rewind's walk is shallow, its undo's would not be
      const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxDepth: 5 });
      const aid = 'wd', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'a', 'b', 'c', 'd', 'e', 'f', 'g.txt'), 'deep\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a folder six deep' });
      fs.rmSync(path.join(wt, 'a'), { recursive: true });
      put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
      A.ok(!!(t && t.created), 'fixture: T recorded with the default depth');
      await refusedClean(st, aid, wt, t.id, 'link_check_failed', /^its undo would have to check folders nested deeper than 5 levels/, 'W depth, a rewind whose undo would walk too deep');
    }
    if (foldsCase) {
      // Ks (capped): the target spells the folder Node_Modules (60 files) below its node_modules rule; the person's
      // node_modules holds mine.txt now. The listing below the pruned folder passes the limit, so each tree's spellings of
      // it are asked of Git (spellings), whose answer passes the limit too, and both are listed inside the folder alone
      const aid = 'ks', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      install(path.join(wt, 'Node_Modules'), 60);
      await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'Node_Modules captured' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'T: the rule, Node_Modules still tracked' });
      fs.rmSync(path.join(wt, 'Node_Modules'), { recursive: true });
      fs.unlinkSync(path.join(wt, '.gitignore'));
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await capped.snapshot(aid, { runId: 'r', turn: 2, label: 'no folder, no rule' });
      A.ok(!!(t && t.created && s1 && s1.created) && tree(aid, t.id).filter((p) => p.startsWith('Node_Modules/')).length === 60, 'fixture: the target spells it Node_Modules/');
      put(path.join(wt, 'node_modules', 'mine.txt'), 'the person\'s, no capture took this\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      cut.length = 0;
      const { mid } = await twoCalls(capped, aid, wt, t.id, 'Ks, a rewind and its undo where the folder\'s case differs past the limit');
      A.ok(Object.keys(mid).filter((k) => /^node_modules\/pkg/i.test(k)).length === 60 && mid['node_modules/mine.txt'] === 'the person\'s, no capture took this\n',
        'Ks: the rewind wrote the target\'s 60 files and kept mine.txt');
    } else console.log('[skip] Ks: this file system does not fold case');
    {
      // this file runs 110-239 s with other gates running (slow.list says when), past test/slow.list's 40 s rule; listed
      // there, a gate gives it 600 s, not 120 s
      const slow = fs.readFileSync(path.join(__dirname, 'slow.list'), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(slow.includes('test/checkpoint-undo.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
    }
  } finally {
    for (const l of links.slice().reverse()) {
      let present = true;
      try { fs.lstatSync(l); } catch (_) { present = false; }
      if (!present) { links.splice(links.indexOf(l), 1); continue; }
      try { unlinkLink(l); } catch (e) { console.log('[cleanup] could not remove link ' + l + ': ' + e.message); }
    }
    if (!links.length) { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {} }
    else console.log('[cleanup] left ' + BASE + ' in place: links remain');
  }
  A.report('checkpoint-undo.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo.test threw — ' + (e && e.stack || e)); process.exit(1); });
