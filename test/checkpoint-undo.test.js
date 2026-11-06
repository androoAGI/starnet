/* node test/checkpoint-undo.test.js — a completed rewind's undo row restores through restoreDetailed, every path and byte,
   or the rewind is refused with no file touched and no undo row (lane checkpoint-links, undo reviews 1-3, 2026-10-30/31;
   sidecar/checkpoint-store.js, the header's THE PROMISE and restore's THE UNDO ROW RESTORES THROUGH THIS API). The lane's
   own rows of the same law are test/checkpoint-undo-closure.test.js (fr1-fr6, row 20 of test/checkpoint-links.test.js until undo review 12)
   and test/checkpoint-store-capped.test.js (row 4c of test/checkpoint-store.test.js until then).

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
   Undo review 2 found, at a3cb72bd, one family the fixes kept meeting again: the walk's reading of what Git ignores,
   links or nests differing from Git's own. It is closed by REFUSAL (the store's THE PROMISE), not by reading Git closer:
     U1-U3 the undo's own count of the tree its reset leaves kept the folders that reset empties, so the undo of a completed
           rewind that removed more than it wrote, near the walk's budget, was refused (link_check_failed; a regression of
           c843de84, as 2d1c2fb9 had no count). Exact now (afterReset): an undo counts what its rewind counted;
     J1 J2 a negation the walk read otherwise than Git (in a `.GITIGNORE`, which Git opens as .gitignore where the file
           system folds case; holding a NUL, where Git's line ends) re-included a node_modules the walk pruned by the
           root's rule: the capture read through a junction there and the reset deleted the files behind it, ok:true
           (2d1c2fb9 the same). Git itself now says which folders a plain rule prunes, and the walk enters one it reads;
     J3    the undo row's node_modules rule in a root `.GITIGNORE` was never read, so the undo took and deleted 40 files
           no capture had taken (2d1c2fb9 the same). Every spelling is read where the file system folds case;
     Y1-Y3 a rewind wrote the target's file into a clone the shadow index held as a gitlink: the undo walked it as a plain
           folder and deleted its working files (Y1), or was refused past the budget (Y2), 2d1c2fb9 the same. Nothing is
           written or deleted below an embedded repository now (repoOnPath), the undo's way round too (Y3), whatever
           folders the reset makes on the way (only since undo review 3: Y4);
     Ks2   no row pinned spellings(): its identity let a rewind write through a junction its other spelling names;
     Q E   a negation that cannot match (`![q]ode_modules/`) still vetoed keeping node_modules out (Codex
           A4-C843-PLAIN-RESIDUAL), and the undo took a .env only a plain rule ignored off disk (the old DEFERRED's first
           bullet). A rewind that changes a rule beyond a plain name, or beside a negation or a NUL, is refused (Q, G2, P3,
           N); a file a plain rule names is kept out like a folder (E); a rule a rewind does not change can be anything (nu).
   Undo review 3 found, at c8e20497, the same family through embedded repositories: each a completed rewind whose
   preRestoreId the API then refused (2d1c2fb9: the undo went ahead and deleted the clone's files, or was refused too):
     Y4    repoOnPath checked a write only where its own folder stood on disk, so the target's Y/sub/a.txt, no sub/ in a
           clone at Y (a gitlink or never captured; a 60-file clone at budget 40; three folders made; at lib/Y; a folder
           whose .git is a junction to a repository), was written into it, and the undo read the clone as a plain folder.
           Every write is checked now;
     Y5 Y6 a gitlink the reset dropped over a folder Git no longer reads as a repository (a vendored clone, its .git
           deleted) left a plain folder the undo took and would have deleted; over a linked worktree or a `.git` junction
           (one gitlink to Git, a plain folder to looksLikeRepo) the undo's walk entered it whole, past the count its
           rewind took. A gitlink a rewind adds or drops at a folder holding anything but a `.git` looksLikeRepo reads as a
           repository is refused (y5a the other way round); a clone goes ahead (y5c);
     N1    nestedRepos answered "none" when its listing passed the runner's limit, so an undo whose index, the target's,
           tracked a long folder beside clones walked them, past its rewind's count. A cut-off listing settles what its
           complete records answer now, and asks the other folders again, in halves down to one.
   Undo review 4's rows (a gitlink recorded where a FILE stands, the depth an undo lists below a folder the reset made
   over one and of a gitlink's own folder, N1's asking again pinned by N2) are test/checkpoint-undo-gitlinks.test.js, a
   step of its own, so this file keeps its room under test/slow.list's 600 s.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The runner's output limit is modelled as in test/checkpoint-store.test.js row 4c: the real runner capped at
   1500 bytes, so tens of long names stand in for the 150k-250k a flat folder needs at 8 MB, and the walk's budget is
   lowered the same way. The rows run eight at a time (runRows): each owns its agent id, work tree, outside folders and
   its capped runner's list of cut-off listings (rowKit), so none reads another's state or timing, and one that throws
   fails alone. Every row runs against a real temp work tree and real git (test/helpers/checkpoint-rows.js says how the
   rows run and how Git is started). Fixtures:
   junctions (Windows) or directory symlinks (POSIX), made inside this test's own os.tmpdir() folder
   and pointing only at sibling folders it made; removed with `cmd /c rmdir` (Windows) / unlink before the folder is
   deleted; and clones (their own .git, made by this file's git, never the shadow repo), and a linked worktree of one
   such clone in this test's own folder (Y6).
   The links are kept to sibling folders it made: a `.git` junction points at such a clone's .git (y4j, y6j). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';

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
async function tree(aid, id) {
  return (await gitRun(['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', String(id).split(':').pop()])).split('\0').filter(Boolean);
}
// Git on the shadow repo of `aid` with its work tree -> { code, out } (a fixture's premise, never the store's own call)
async function gitIn(aid, args) {
  try { return { code: 0, out: await gitRun(['--git-dir', gitDirOf(aid), '--work-tree', path.join(ROOT, aid)].concat(args), { cwd: path.join(ROOT, aid) }) }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || '') }; }
}
// a clone with one commit in `dir` (its own .git, never the shadow repo's), from `files`; its commit starts no background
// `git maintenance run --auto`, as none of the store's own commits does
async function clone(dir, files) {
  for (const [rel, body] of Object.entries(files)) put(path.join(dir, rel), body);
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  await gitRun(['init', '-q'], { cwd: dir });
  await gitRun(id.concat(['add', '-A']), { cwd: dir });
  await gitRun(id.concat(['commit', '-q', '-m', 'c']), { cwd: dir });
}
const flatName = (i) => 'sample_' + String(i).padStart(4, '0') + '_with_a_long_descriptive_name.bin';
const install = (dir, n, name) => { for (let i = 0; i < n; i++) put(path.join(dir, 'pkg' + (i % 8), 'lib', (name || 'f') + i + '.js'), 'x' + i + '\n'); };

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  const budget = (n) => makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: n });
  // the real runner, its output limit 1500 bytes
  const cappedRunner = makeCheckpointGitRunner({ spawn: launchSpawn, maxBytes: 1500, clock: { now: () => Date.now() } });
  const verbOf = (args) => args.find((a) => /^(diff-index|diff-tree|ls-files|ls-tree|grep|cat-file|check-ignore)$/.test(a)) || '?';

  // a row's own kit: `cut` names the Git verbs its capped runner cut off since it was last emptied, and `capped` is a store
  // on that runner
  const rowKit = () => {
    const cut = [];
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
    return { cut: cut, capped: capped, twoCalls: twoCalls, refusedClean: refusedClean };
  };
  const rows = [];
  const row = (name, fn) => { rows.push({ name: name, fn: fn }); };
  const nodeModulesIn = async (aid, id) => (await tree(aid, id)).filter((p) => /^node_modules\//i.test(p)).length;
  const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false'];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  try {
    // ================= G1: the undo reads its row's changed .gitignore files =================
    row('g1a', async ({ capped, twoCalls }) => {
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
      A.ok(!!(t0 && t0.created && s1 && s1.created) && lines.length < 1500 && (await tree(aid, s1.id)).length === 3, 'fixture: S1\'s .gitignore is under the limit in bytes, and no capture took node_modules');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { u, undoCut } = await twoCalls(capped, aid, wt, t0.id, 'G1a, an undo whose row\'s .gitignore lines pass the limit with grep\'s prefix');
      A.ok(undoCut.includes('grep'), 'fixture: the undo\'s grep of them passed the limit (' + JSON.stringify(undoCut) + ')');
      A.eq(u && u.preRestoreId ? (await nodeModulesIn(aid, u.preRestoreId)) : -1, 0, 'G1a: the undo read its row\'s node_modules rule, so its capture left node_modules out');
    });
    row('g1b', async ({ capped, refusedClean }) => {
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
    });

    // ================= G2, G3: every .gitignore is read as text, whatever Git's binary detection says =================
    row('g2', async ({ refusedClean }) => {
      // G2: S1's .gitignore lists node_modules and holds a NUL byte, so grep -I took it for binary and skipped it; Git and
      // the walk still read its node_modules line. The undo dropped that rule and walked node_modules: refused past the
      // budget, within it its capture took the 70 files and its reset deleted them. Read with -a since undo review 1; since
      // undo review 2 a rewind that changes a .gitignore holding a NUL is refused (Git reads a line up to the NUL, the walk
      // does not), before anything is touched
      const aid = 'g2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
      put(path.join(wt, '.gitignore'), Buffer.from('node_modules\n\u0000\n', 'latin1'));
      put(path.join(wt, 'app.js'), 'v1\n');
      install(path.join(wt, 'node_modules'), 70);
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a .gitignore holding a NUL' });
      A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, 3], 'fixture: no capture took node_modules');
      // the premises (Codex review of a009): its rule is in force (check-ignore names it), and grep -I takes it for binary
      A.eq((await gitIn(aid, ['check-ignore', '-v', 'node_modules/pkg0/lib/f0.js'])).out.trim(), '.gitignore:1:node_modules\tnode_modules/pkg0/lib/f0.js', 'fixture: Git ignores node_modules by that .gitignore');
      A.eq([(await gitIn(aid, ['grep', '-I', '-c', '-e', '', s1.id, '--', '.gitignore'])).code, (await gitIn(aid, ['grep', '-a', '-c', '-e', '', s1.id, '--', '.gitignore'])).out.trim()],
        [1, s1.id + ':.gitignore:2'], 'fixture: grep -I skips that .gitignore as binary, grep -a reads its two lines');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(store, aid, wt, t0.id, 'uncaptured_check_failed', /^the rewind would change \.gitignore rules beyond plain names: "\.gitignore" holds a NUL byte/, 'g2, a rewind that changes a .gitignore holding a NUL byte');
    });
    row('g3', async ({ twoCalls }) => {
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
    });

    // ================= R2, Ra, P1, P2: a listing below a pruned folder never reads a whole folder above it =================
    row('r2', async ({ capped, twoCalls }) => {
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
    });
    row('ra', async ({ capped, twoCalls }) => {
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
    });
    row('p1', async ({ capped, twoCalls }) => {
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
    });
    row('p2', async ({ capped, twoCalls }) => {
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
    });

    // ================= P3: a folder of files no capture took where the target holds a FILE =================
    // P3 is Codex's target-file witness (review of a009): T records dist/slot as a regular file below its own dist rule; S,
    // captured while dist/slot was still a file, ignores something else; then dist/slot alone becomes a folder of files no
    // capture took. With --directory Git printed nothing for dist/slot while the index held it as a file, so reset deleted
    // the folder with them, ok:true, in no row (undo review 1). They are taken by name since. With S's rule `*.log` (a glob)
    // the rewind is refused untouched (outcome A: undo review 2, a rewind that changes a rule beyond a plain name); with the
    // plain `logs` it goes ahead and both calls bring every path and byte back, the folder and its nested files (outcome B)
    for (const [aid, rule] of [['p3', '*.log\n'], ['p3p', 'logs\n']]) row(aid, async ({ twoCalls, refusedClean }) => {
      const wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'slot'), 'slot v0\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'keep\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'dist/slot a file, no dist rule' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: dist ignored, dist/slot still tracked' });
      put(path.join(wt, '.gitignore'), rule);
      const s = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S: another rule, dist/slot still a file' });
      A.ok(!!(t && s && s.created) && (await tree(aid, t.id)).includes('dist/slot') && /^100644 [0-9a-f]+ 0\tdist\/slot$/m.test((await gitIn(aid, ['ls-files', '-s', '--', 'dist/slot'])).out),
        'fixture (' + aid + '): T records dist/slot as a file, and the shadow index still does');
      fs.unlinkSync(path.join(wt, 'dist', 'slot'));
      put(path.join(wt, 'dist', 'slot', 'user.txt'), 'the person\'s, no capture took this\n');
      put(path.join(wt, 'dist', 'slot', 'deep', 'more.txt'), 'deeper, no capture took this\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'keep EDITED, a tracked file below the target-only rule\n');   // Codex's control: still recoverable
      put(path.join(wt, 'app.js'), 'v1, no capture took this\n');
      if (aid === 'p3') {
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /rewinding changes the rule "\*\.log" in "\.gitignore", which is not one plain name/, 'P3, a rewind over a folder only the target\'s .gitignore lists, its rule changed from a glob');
        return;
      }
      const { r, mid } = await twoCalls(store, aid, wt, t.id, 'P3 plain, a rewind over a folder only the target\'s .gitignore lists');
      A.eq([mid['dist/slot'], mid['dist/keep.txt']], ['slot v0\n', 'keep\n'], 'P3 plain: the rewind wrote the target\'s file dist/slot and its dist/keep.txt over the edit (the undo brought the edit back: above)');
      A.eq(r && r.preRestoreId ? (await tree(aid, r.preRestoreId)).filter((p) => /^dist\/slot\//.test(p)) : [], ['dist/slot/deep/more.txt', 'dist/slot/user.txt'], 'P3 plain: the undo row holds both, taken by name');
    });
    row('p3b', async ({ refusedClean }) => {
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
    });
    row('p3c', async ({ refusedClean }) => {
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
    });
    row('p3d', async ({ cut, capped, refusedClean }) => {
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
    });

    // ================= N, Q, K: a folder the undo row's .gitignore names, that the walk could not prune =================
    {
      // N: two lines of github/gitignore's VisualStudio.gitignore, `node_modules/` and a double-star bracket negation of a
      // Packages build folder. The negation matched every folder to the walk, so neither walk pruned node_modules: the
      // rewind's capture left it out (Git ignores it), the undo's took its 70 files (no rule now) and its reset deleted them.
      // Q (Codex A4-C843-PLAIN-RESIDUAL): undo review 1 matched a bracket as any one character, so `![q]ode_modules/` still
      // vetoed keeping node_modules out, and the undo took and deleted node_modules/user.txt. Qc, the control: a negation
      // that does re-include it. Since undo review 2 a rewind that changes a .gitignore holding any negation is refused,
      // untouched: a negation can re-include what the undo keeps out of its capture, or the reverse
      for (const [aid, rules, label] of [['n', 'node_modules/\n!**/[Pp]ackages/build/\n', 'N, beside a double-star bracket negation'],
        ['q', 'node_modules/\n![q]ode_modules/\n', 'Q, beside a negation that cannot match it'],
        ['qc', 'node_modules/\n!node_modules/\n', 'Qc, beside a negation that re-includes it']]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'package.json'), '{}\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
        put(path.join(wt, '.gitignore'), rules);
        put(path.join(wt, 'app.js'), 'v1\n');
        put(path.join(wt, 'node_modules', 'user.txt'), 'the person\'s, ' + (aid === 'qc' ? 'captured' : 'ignored') + '\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: node_modules/ beside a negation' });
        A.eq([!!(t0 && t0.created), s1 && s1.created && s1.files], [true, aid === 'qc' ? 4 : 3], 'fixture (' + aid + '): Git ' + (aid === 'qc' ? 'reads' : 'ignores') + ' node_modules/user.txt');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t0.id, 'uncaptured_check_failed', /^the rewind would change \.gitignore rules beyond plain names: "\.gitignore" holds (a negation|the negation)/, label);
      });
    }
    row('nu', async ({ twoCalls }) => {
      // and the rules a rewind does not change can be anything: a glob and a negation in an unchanged .gitignore, a log they
      // ignore, a rewind of app.js alone goes ahead and its undo brings every path and byte back (both sides ignore alike)
      const aid = 'nu', wt = path.join(ROOT, aid);
      put(path.join(wt, '.gitignore'), '*.log\n!keep.log\nnode_modules/\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'keep.log'), 'kept by the negation\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: a glob and a negation' });
      put(path.join(wt, 'app.js'), 'v1\n');
      put(path.join(wt, 'debug.log'), 'ignored, no capture took this\n');
      install(path.join(wt, 'node_modules'), 12);
      A.eq(t0 && (await tree(aid, t0.id)), ['.gitignore', 'app.js', 'keep.log'], 'fixture: T0 holds keep.log, re-included');
      await twoCalls(store, aid, wt, t0.id, 'a rewind that changes no .gitignore, beside a glob and a negation');
    });
    row('nc', async () => {
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
      A.eq(s ? (await tree(aid, s.id)) : [], ['.gitignore', 'node_modules/own.js'], 'N control: the capture holds node_modules\' own file and nothing from behind the junction');
    });
    if (foldsCase) row('k', async ({ twoCalls }) => {
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
      A.eq(u && u.preRestoreId ? (await nodeModulesIn(aid, u.preRestoreId)) : -1, 0, 'K: the undo\'s capture left node_modules out');
    }); else console.log('[skip] K: this file system does not fold case');
    // ================= W: the undo's walk counts the tree the reset leaves =================
    row('w', async ({ twoCalls, refusedClean }) => {
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
    });
    row('wd', async ({ refusedClean }) => {
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
    });
    if (foldsCase) row('ks', async ({ cut, capped, refusedClean }) => {
      // Ks (capped): the target spells the folder Node_Modules (60 files) below its node_modules rule; the person's
      // node_modules holds mine.txt now. The listing below the pruned folder passes the limit, so each tree's spellings of it
      // are asked of Git (spellings), whose answer passes the limit too, and both are listed inside the folder alone. Both
      // calls went ahead until undo review 11: any path a tree spells otherwise than the disk refuses a rewind now, last of
      // its checks (the store's SPELLED, checkpoint-undo-case fn1-fn4)
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
      A.ok(!!(t && t.created && s1 && s1.created) && (await tree(aid, t.id)).filter((p) => p.startsWith('Node_Modules/')).length === 60, 'fixture: the target spells it Node_Modules/');
      put(path.join(wt, 'node_modules', 'mine.txt'), 'the person\'s, no capture took this\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      cut.length = 0;
      await refusedClean(capped, aid, wt, t.id, 'uncaptured_check_failed', /^"node_modules" is spelled "Node_Modules" in the restore point/, 'Ks, a rewind where the folder\'s case differs past the limit');
      A.ok(cut.includes('ls-files') && cut.includes('diff-tree'), 'Ks, fixture: the listing and the spellings asked of Git passed the limit (' + JSON.stringify(cut) + ')');
    }); else console.log('[skip] Ks: this file system does not fold case');
    if (foldsCase) row('ks2', async ({ cut, capped, refusedClean }) => {
      // Ks2 (undo review 2: no row pinned spellings(); its identity let this rewind write through a junction): Ks with
      // node_modules/pkg0 a junction to a sibling folder. The target's Node_Modules/pkg0/... lie through it, found only by
      // the other spelling past the limit: refused (link_in_path), the folder behind the junction untouched
      const aid = 'ks2', wt = path.join(ROOT, aid);
      const out = path.join(BASE, 'ks2-outside');
      put(path.join(out, 'o.txt'), 'outside\n');
      put(path.join(wt, 'app.js'), 'v0\n');
      install(path.join(wt, 'Node_Modules'), 60);
      await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'Node_Modules captured' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'T: the rule, Node_Modules still tracked' });
      fs.rmSync(path.join(wt, 'Node_Modules'), { recursive: true });
      fs.unlinkSync(path.join(wt, '.gitignore'));
      put(path.join(wt, 'app.js'), 'v1\n');
      await capped.snapshot(aid, { runId: 'r', turn: 2, label: 'no folder, no rule' });
      put(path.join(wt, 'node_modules', 'mine.txt'), 'the person\'s, no capture took this\n');
      link(out, path.join(wt, 'node_modules', 'pkg0'));
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      cut.length = 0;
      const r = await refusedClean(capped, aid, wt, t.id, 'link_in_path', /^"node_modules\/pkg0" is a link .* and rewinding would write or delete "Node_Modules\/pkg0\//, 'Ks2, a rewind whose target writes through a junction its other spelling names');
      A.ok(cut.includes('ls-files') && cut.includes('diff-tree'), 'fixture: the listing and the spellings asked of Git passed the limit (' + JSON.stringify(cut) + ')');
      A.eq([(r && r.links || []).every((l) => l.link === 'node_modules/pkg0'), listing(out)], [true, { 'o.txt': 'outside\n' }], 'Ks2: naming the junction, the folder behind it untouched');
    }); else console.log('[skip] Ks2: this file system does not fold case');

    // ================= U: the undo's own count of the tree its reset leaves is exact (undo review 2) =================
    {
      // the reviews' three shapes: a rewind that removes more than it writes, in a tree near the walk's budget. Its undo
      // counted the tree its own reset would leave without taking away the folders that reset empties (the ones the rewind
      // made), so the undo of a completed rewind was refused (link_check_failed), every removed file and the edit in the
      // shadow repo only (a regression of c843de84; 2d1c2fb9 had no count and went ahead)
      // U1 (budget 40): T = 38 files and new/x.txt; S1 = the 38 and del1, del2; f01 edited since
      row('u1', async ({ twoCalls }) => {
        const st = budget(40), aid = 'u1', wt = path.join(ROOT, aid);
        for (let i = 1; i <= 38; i++) put(path.join(wt, 'f' + String(i).padStart(2, '0') + '.txt'), 'f' + i + '\n');
        put(path.join(wt, 'new', 'x.txt'), 'x in T\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(wt, 'new'), { recursive: true });
        put(path.join(wt, 'del1.txt'), 'del1\n');
        put(path.join(wt, 'del2.txt'), 'del2\n');
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        A.eq([t && t.files, s1 && s1.created && s1.files], [39, 40], 'fixture: both walk 40 entries');
        put(path.join(wt, 'f01.txt'), 'f01 v2, no snapshot took this\n');
        await twoCalls(st, aid, wt, t.id, 'U1, an undo that brings back two files and empties the folder its rewind made (budget 40)');
      });
      // U2 (budget 60): the walk counts 56 now (10 files, old/ of 45); T = the 10 and n1-n6/one.txt
      row('u2', async ({ twoCalls }) => {
        const st = budget(60), aid = 'u2', wt = path.join(ROOT, aid);
        for (let i = 1; i <= 10; i++) put(path.join(wt, 'r' + i + '.txt'), 'r' + i + '\n');
        for (let k = 1; k <= 6; k++) put(path.join(wt, 'n' + k, 'one.txt'), 'n' + k + '\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        for (let k = 1; k <= 6; k++) fs.rmSync(path.join(wt, 'n' + k), { recursive: true });
        for (let i = 0; i < 45; i++) put(path.join(wt, 'old', 'o' + i + '.txt'), 'o' + i + '\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'r1.txt'), 'r1 v2, no snapshot took this\n');
        await twoCalls(st, aid, wt, t.id, 'U2, an undo that brings back old/ and empties six folders its rewind made (budget 60)');
      });
      // U3 (budget 60): T holds app.js, f1-f6 and gen/x/y/f.txt; now gen is gone and data/ holds 50 files (the walk counts 58)
      row('u3', async ({ twoCalls }) => {
        const st = budget(60), aid = 'u3', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 1; i <= 6; i++) put(path.join(wt, 'f' + i + '.txt'), 'f' + i + '\n');
        put(path.join(wt, 'gen', 'x', 'y', 'f.txt'), 'generated\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(wt, 'gen'), { recursive: true });
        for (let i = 0; i < 50; i++) put(path.join(wt, 'data', 'd' + i + '.txt'), 'd' + i + '\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        A.ok(!!(t && t.created), 'fixture: T recorded');
        await twoCalls(st, aid, wt, t.id, 'U3, an undo that brings back data/ and empties gen/x/y (budget 60)');
      });
    }

    // ================= J: Git's own answer on the folders the walk prunes, and every spelling of .gitignore =================
    {
      // J1 (case-folding file systems) and J2: T holds a root .gitignore listing node_modules and a sub/ ignore file whose
      // negation re-includes sub/node_modules, spelled sub/.GITIGNORE (Git opens .gitignore and gets it) or holding a NUL after
      // the pattern (Git reads the line up to it). Since T: sub/node_modules/own.js and jx, a junction to a sibling folder.
      // The walk read neither negation as Git does and pruned sub/node_modules by the root's rule, so jx was never left out
      // of Git's view: the capture read through it and the reset deleted both files behind it, ok:true (2d1c2fb9 the same).
      // Git is asked about every folder the walk prunes by the work tree's own rules now, and enters one Git reads
      const shapes = [['j2', '.gitignore', Buffer.from('!node_modules\u0000 x\n', 'latin1')]];
      if (foldsCase) shapes.unshift(['j1', '.GITIGNORE', '!node_modules\n']);
      else console.log('[skip] J1: this file system does not fold case');
      for (const [aid, name, body] of shapes) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid), out = path.join(BASE, aid + '-outside');
        put(path.join(out, 'old.txt'), 'outside old\n');
        put(path.join(wt, '.gitignore'), 'node_modules\n');
        put(path.join(wt, 'sub', name), body);
        put(path.join(wt, 'sub', 'index.js'), 'sub\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no sub/node_modules' });
        put(path.join(wt, 'sub', 'node_modules', 'own.js'), 'own\n');
        link(out, path.join(wt, 'sub', 'node_modules', 'jx'));
        put(path.join(out, 'new.txt'), 'outside new, the linked package\'s file\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        A.eq((await gitIn(aid, ['check-ignore', '--no-index', 'sub/node_modules'])).code, 1, 'fixture (' + aid + '): Git reads sub/node_modules (' + name + '\'s negation)');
        const { r } = await twoCalls(store, aid, wt, t.id, aid + ', a rewind past a node_modules a negation in ' + name + ' re-includes, a junction in it');
        A.eq((r && r.links || []).map((l) => l.path), ['sub/node_modules/jx'], aid + ': the walk entered it and left the junction where it was');
        A.ok(!!(r && r.preRestoreId) && !(await tree(aid, r.preRestoreId)).some((p) => /\/jx\//.test(p)), aid + ': the undo row holds nothing read through it');
        A.eq(listing(out), { 'new.txt': 'outside new, the linked package\'s file\n', 'old.txt': 'outside old\n' }, aid + ': the folder behind the junction is untouched');
      });
    }
    if (foldsCase) row('j3', async ({ twoCalls }) => {
      // J3 (the r3 MAJOR through a root .GITIGNORE): S1 tracks 16 node_modules files, no rule; S2's root .GITIGNORE lists
      // node_modules and 40 extras went in since (no capture took them); app.js v2 since. The undo read only a .gitignore
      // spelled so (its diff-index pathspec, the walk), never its row's rule, so its capture took the 40 and its reset
      // deleted them (2d1c2fb9 the same). Every spelling is read where the file system folds case
      const aid = 'j3', wt = path.join(ROOT, aid), nm = path.join(wt, 'node_modules');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 16; i++) put(path.join(nm, 'pkg' + (i % 8), 'lib', 'file_' + i + '.js'), 'x' + i + '\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S1: node_modules captured, no rule' });
      put(path.join(wt, '.GITIGNORE'), 'node_modules\n');
      for (let i = 0; i < 40; i++) put(path.join(nm, 'extra', 'e_' + i + '.js'), 'e' + i + '\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S2: a .GITIGNORE lists node_modules, 40 extras' });
      A.eq([s1 && s1.files, s2 && s2.created && s2.files], [17, 18], 'fixture: both rows track the 16 files, neither an extra');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { u } = await twoCalls(store, aid, wt, s1.id, 'J3, an undo whose row\'s rule is in a root .GITIGNORE');
      A.ok(!!(u && u.preRestoreId) && !(await tree(aid, u.preRestoreId)).some((p) => /\/extra\//.test(p)), 'J3: the undo\'s capture left the extras out');
    }); else console.log('[skip] J3: this file system does not fold case');

    // ================= Y: nothing is written or deleted below an embedded repository (the store's repoOnPath) =================
    {
      // Y1 (default budget) and Y2 (budget 40, a clone of 60 files): T holds Y/a.txt as a plain file; S1 has no Y; S2 holds a
      // clone at Y (one gitlink); then an uncommitted edit and a new file in the clone, app.js edited. The rewind wrote
      // Y/a.txt into the clone (nothing stood there), so the index tracked plain files below Y: its undo walked the clone as
      // a plain folder, took its working files and deleted them with its reset, ok:true (Y1), or was refused past the
      // budget (Y2), 2d1c2fb9 the same. Refused now, untouched: every path and byte of the clone where it was
      for (const [aid, max, n] of [['y1', 0, 12], ['y2', 40, 60]]) row(aid, async ({ refusedClean }) => {
        const st = max ? budget(max) : store;
        const wt = path.join(ROOT, aid), Y = path.join(wt, 'Y');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(Y, 'a.txt'), 'a in T\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: Y a plain folder' });
        fs.rmSync(Y, { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no Y' });
        const files = { 'b.txt': 'b committed\n' };
        for (let i = 0; i < n; i++) files['src/m' + i + '.js'] = 'module ' + i + '\n';
        await clone(Y, files);
        const s2 = await st.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: Y a clone' });
        A.ok(!!(s2 && s2.created) && /^160000 [0-9a-f]+ 0\tY$/m.test((await gitIn(aid, ['ls-files', '-s', '--', 'Y'])).out), 'fixture (' + aid + '): the shadow index records Y as a gitlink');
        put(path.join(Y, 'b.txt'), 'b EDITED in the clone, uncommitted\n');
        put(path.join(Y, 'untracked-in-clone.txt'), 'the person\'s new file in the clone\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_in_path', /^"Y" is an embedded Git repository .* rewinding would write "Y\/a\.txt" inside it/, aid + ', a rewind that would write into a clone the index holds as a gitlink' + (max ? ' (budget ' + max + ')' : ''));
      });
    }
    row('y3', async ({ refusedClean }) => {
      // Y3: the same folder the other way round. S tracks Y/a.txt (a plain folder), then `git init` in Y (Git still reads it
      // as plain: the index tracks a path below it); T has no Y. The rewind would delete Y/a.txt and leave Y holding only its
      // .git, and its undo would write Y/a.txt below a folder Git then takes for a repository: refused (Y1's rule, the
      // undo's way round), so the undo of a rewind that passed never meets it
      const aid = 'y3', wt = path.join(ROOT, aid), Y = path.join(wt, 'Y');
      put(path.join(wt, 'app.js'), 'v0\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no Y' });
      put(path.join(Y, 'a.txt'), 'a\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S: Y/a.txt' });
      await gitRun(['init', '-q'], { cwd: Y });
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"Y" is an embedded Git repository .* rewinding would delete "Y\/a\.txt" inside it/, 'Y3, a rewind that would delete inside a folder that holds a .git the target lacks');
    });

    // ================= undo review 3: a clone below what the reset makes, a gitlink it adds or drops, Git's nesting answer =================
    {
      // Y4 (the security and correctness BLOCKER): Y1 one folder deeper. T holds Y/sub/a.txt (a plain folder then); S1 has
      // no Y; S2 a clone at Y, one gitlink, with no sub/ in it; then an uncommitted edit and a new file in the clone, app.js
      // edited. repoOnPath checked a write only where its own folder stood on disk, so the reset wrote Y/sub/a.txt into the
      // clone and the rewind completed; its undo, the index tracking a path below Y, read the clone as a plain folder and
      // was refused (uncaptured_in_path; past the budget, link_check_failed), app.js v2 in the shadow repo only (2d1c2fb9:
      // the undo deleted the clone's 14 files). Every write is checked now, whatever folders the reset makes on the way.
      // y4u: the clone never captured (a gitlink only in the capture the rewind stages); y4b: budget 40, a 60-file clone;
      // y4d: Y/a/b/c.txt, three folders made; y4l: the clone at lib/Y; y4c, the control: the clone holds Y/sub (Y1's rule)
      for (const [aid, max, n, recorded, at, write, more] of [['y4', 0, 12, true, 'Y', 'Y/sub/a.txt'], ['y4u', 0, 12, false, 'Y', 'Y/sub/a.txt'],
        ['y4b', 40, 60, true, 'Y', 'Y/sub/a.txt'], ['y4d', 0, 12, true, 'Y', 'Y/a/b/c.txt'], ['y4l', 0, 12, true, 'lib/Y', 'lib/Y/sub/a.txt'],
        ['y4c', 0, 12, true, 'Y', 'Y/sub/a.txt', { 'sub/c.txt': 'c committed\n' }]]) row(aid, async ({ refusedClean }) => {
        const st = max ? budget(max) : store;
        const wt = path.join(ROOT, aid), Y = path.join(wt, at);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, write), 'in T\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + write + ' in a plain folder' });
        fs.rmSync(path.join(wt, write.split('/')[0]), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: none of it' });
        const files = Object.assign({ 'b.txt': 'b committed\n' }, more || {});
        for (let i = 0; i < n; i++) files['src/m' + i + '.js'] = 'module ' + i + '\n';
        await clone(Y, files);
        if (recorded) {
          const s2 = await st.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: ' + at + ' a clone' });
          A.ok(!!(s2 && s2.created) && new RegExp('^160000 [0-9a-f]+ 0\\t' + esc(at) + '$', 'm').test((await gitIn(aid, ['ls-files', '-s', '--', at])).out), 'fixture (' + aid + '): the shadow index records ' + at + ' as a gitlink');
        } else A.eq((await gitIn(aid, ['ls-files', '--', at])).out, '', 'fixture (' + aid + '): no capture took the clone');
        put(path.join(Y, 'b.txt'), 'b EDITED in the clone, uncommitted\n');
        put(path.join(Y, 'untracked-in-clone.txt'), 'the person\'s new file in the clone\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_in_path', new RegExp('^"' + esc(at) + '" is an embedded Git repository .* rewinding would write "' + esc(write) + '" inside it'),
          aid + ', a rewind that would write ' + write + ' into a clone' + (more ? ' that holds its folder' : '') + (recorded ? '' : ' no capture took') + (max ? ' (budget ' + max + ')' : ''));
      });
    }
    row('y4j', async ({ refusedClean }) => {
      // y4j: the same through a folder whose .git is a junction to a repository (a plain folder to the walk's looksLikeRepo,
      // one gitlink to Git), never captured: the target writes X/sub/a.txt, X/sub absent
      const aid = 'y4j', wt = path.join(ROOT, aid), X = path.join(wt, 'X'), repo = path.join(BASE, 'y4j-repo');
      await clone(repo, { 'README': 'repo\n' });
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(X, 'sub', 'a.txt'), 'in T\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: X/sub/a.txt in a plain folder' });
      fs.rmSync(X, { recursive: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no X' });
      fs.mkdirSync(X);
      link(path.join(repo, '.git'), path.join(X, '.git'));
      put(path.join(X, 'README'), 'the person\'s working copy, edited\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"X" is an embedded Git repository .* rewinding would write "X\/sub\/a\.txt" inside it/, 'y4j, a rewind that would write into a folder whose .git is a junction to a repository');
      A.ok(isLink(path.join(X, '.git')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'y4j: the junction and the repository behind it are where they were');
    });
    {
      // Y5 (the security BLOCKER, a vendored clone): S1 records a clone at Y (b.txt and 12 files) as a gitlink; the person
      // deletes Y/.git and edits Y/b.txt, and S2 still records the gitlink (`add -A` keeps it and takes none of Y's files);
      // app.js v3 since. The rewind to T, from before Y, dropped the gitlink and left Y's files a plain folder: its undo's
      // capture took them and its reset would have deleted them (2d1c2fb9 did, ok:true, 13 files gone), so repoOnPath
      // refused that undo and the preRestoreId stranded app.js v3. A rewind that adds or drops a gitlink over a folder of
      // files is refused now (the store's gitlinkOverFiles), untouched: y5 at the root, y5l at lib/Y. y5c, the control: the
      // clone's .git intact, so both calls go ahead
      for (const [aid, at, vendored] of [['y5', 'Y', true], ['y5l', 'lib/Y', true], ['y5c', 'Y', false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid), Y = path.join(wt, at);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no ' + at });
        const files = { 'b.txt': 'b committed\n' };
        for (let i = 0; i < 12; i++) files['src/m' + i + '.js'] = 'module ' + i + '\n';
        await clone(Y, files);
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: ' + at + ' a clone' });
        if (vendored) fs.rmSync(path.join(Y, '.git'), { recursive: true, force: true });
        put(path.join(Y, 'b.txt'), 'b EDITED' + (vendored ? ' after vendoring' : ', uncommitted') + '\n');
        put(path.join(wt, 'app.js'), 'v2\n');
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: ' + at + (vendored ? ' vendored' : ' edited') });
        const held = (await gitIn(aid, ['ls-files', '-s', '--', at])).out;
        A.ok(!!(s2 && s2.created) && held.trim().split('\n').length === 1 && new RegExp('^160000 [0-9a-f]+ 0\\t' + esc(at) + '$', 'm').test(held), 'fixture (' + aid + '): S2 still records ' + at + ' as one gitlink, none of its files');
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        if (!vendored) { await twoCalls(store, aid, wt, t.id, 'y5c, a rewind that drops the gitlink of a clone'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', new RegExp('^"' + esc(at) + '" is recorded as an embedded Git repository \\(a gitlink\\) but holds no repository the checkpoint can read .* rewinding would drop that record'),
          aid + ', a rewind that would drop the gitlink of a clone whose .git is gone');
      });
    }
    row('y5a', async ({ refusedClean }) => {
      // y5a, the other way round (the rule that keeps the undo of a completed rewind from meeting y5's): T records a clone
      // at Y; S1 has no Y; now Y is a folder holding a file only the work tree's .gitignore ignores, and no .git. The reset
      // would record the gitlink over it, and its undo drop it again over that file: refused, untouched
      const aid = 'y5a', wt = path.join(ROOT, aid), Y = path.join(wt, 'Y');
      put(path.join(wt, 'app.js'), 'v0\n');
      await clone(Y, { 'b.txt': 'b committed\n' });
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: Y a clone' });
      A.ok(!!t && /^160000 [0-9a-f]+ 0\tY$/m.test((await gitIn(aid, ['ls-files', '-s', '--', 'Y'])).out), 'fixture (y5a): T records Y as a gitlink');
      fs.rmSync(Y, { recursive: true, force: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no Y' });
      put(path.join(wt, '.gitignore'), 'Y\n');
      put(path.join(Y, 'notes.txt'), 'the person\'s, ignored, no capture took this\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"Y" holds files but no repository the checkpoint can read .* rewinding would record it as an embedded Git repository/, 'y5a, a rewind that would record a gitlink over a folder of ignored files');
    });
    {
      // Y6 (the security and correctness BLOCKER, a linked worktree; budget 40): W is a linked worktree of a repository
      // outside the workspace, recorded by S1 as a gitlink while small; it grows by 60 files and S2 skips it (the index
      // names the gitlink). The rewind to T, from before W, dropped the gitlink: its walk had skipped W only because its
      // index named it, and its undo's walk (looksLikeRepo: no, a commondir) entered W whole, past the count the rewind
      // took (link_check_failed; 2d1c2fb9 the same). Refused now, untouched (gitlinkOverFiles); y6j: a folder whose .git is
      // a junction to a repository, recorded as a gitlink the same way
      for (const [aid, kind] of [['y6', 'worktree'], ['y6j', 'junction']]) row(aid, async ({ refusedClean }) => {
        const st = budget(40), wt = path.join(ROOT, aid), W = path.join(wt, 'W'), main = path.join(BASE, aid + '-main');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no W' });
        await clone(main, { 'README': 'main\n' });
        if (kind === 'worktree') await gitRun(ident.concat(['worktree', 'add', '-q', '--detach', W]), { cwd: main });
        else { fs.mkdirSync(W); link(path.join(main, '.git'), path.join(W, '.git')); put(path.join(W, 'README'), 'main\n'); }
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: W small' });
        A.ok(!!(s1 && s1.created) && /^160000 [0-9a-f]+ 0\tW$/m.test((await gitIn(aid, ['ls-files', '-s', '--', 'W'])).out), 'fixture (' + aid + '): S1 records W as a gitlink');
        for (let i = 0; i < 60; i++) put(path.join(W, 'src', 'm' + i + '.js'), 'module ' + i + '\n');
        put(path.join(wt, 'app.js'), 'v2\n');
        const s2 = await st.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: W big, skipped as a gitlink' });
        A.ok(!!(s2 && s2.created), 'fixture (' + aid + '): S2\'s walk skips W within the budget of 40');
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_in_path', /^"W" is recorded as an embedded Git repository \(a gitlink\) but holds no repository the checkpoint can read .* rewinding would drop that record/,
          aid + ', a rewind that would drop the gitlink of a ' + (kind === 'worktree' ? 'linked worktree' : 'folder whose .git is a junction') + ' (budget 40)');
      });
    }
    row('n1', async ({ cut, twoCalls }) => {
      // N1 (the security and correctness BLOCKER; the real runner capped at 1500 bytes, budget 70): T, recorded with no
      // output limit, tracks X/ of 30 long names; then X keeps two of them and gets a `git init` (Git still reads it as a
      // plain folder: the index tracks paths below it), and C and D are clones of 25 files each beside it; S1 records each
      // as a gitlink. The rewind writes 28 files back into X. Its undo asked the index, the target's now, which of C, D
      // and X are repositories: that listing passed the limit and answered "none", so the undo's walk entered C and D,
      // which the rewind's had skipped, past the count its rewind took (link_check_failed; 2d1c2fb9 the same). A cut-off
      // listing settles what its complete records answer now (X) and asks the rest again, in halves (C, then D), so both
      // walks skip the clones and both calls go ahead
      const aid = 'n1', wt = path.join(ROOT, aid), X = path.join(wt, 'X');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 30; i++) put(path.join(X, 'x' + flatName(i).slice(0, 30)), 'x' + i + '\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: X with 30 files' });
      for (let i = 2; i < 30; i++) fs.unlinkSync(path.join(X, 'x' + flatName(i).slice(0, 30)));
      await gitRun(['init', '-q'], { cwd: X });
      for (const c of ['C', 'D']) {
        const files = {};
        for (let i = 0; i < 25; i++) files['src/m' + i + '.js'] = c + ' module ' + i + '\n';
        await clone(path.join(wt, c), files);
      }
      put(path.join(wt, 'app.js'), 'v1\n');
      const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, scanMaxEntries: 70,
        runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
      const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: X two files and a .git, C and D clones' });
      A.eq([t && t.files, s1 && s1.created && s1.files], [31, 5], 'fixture: T tracks 30 files in X; S1 two, and C and D as one gitlink each');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { undoCut } = await twoCalls(st, aid, wt, t.id, 'N1, an undo whose index tracks a long folder beside two clones');
      A.ok(undoCut.includes('ls-files'), 'fixture: the undo\'s question of which folders are repositories passed the limit (' + JSON.stringify(undoCut) + ')');
    });

    // ================= E: a plain rule for a FILE, which the undo row's .gitignore holds and the target's lacks =================
    row('e', async ({ twoCalls }) => {
      // E: S1's .gitignore lists .env (one plain name), and the person's .env is in no capture; T0 has no .gitignore. The
      // rewind keeps .env (no capture took it). Its undo, under T0's rules, took .env with its capture and deleted it with
      // its reset, held only in the undo's own undo row (2d1c2fb9 the same; the old DEFERRED's first bullet). A file only the
      // target's rules name is kept out of the capture like such a folder now (scanTree's keptFile): every path and byte back
      const aid = 'e', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no .gitignore' });
      put(path.join(wt, '.gitignore'), '.env\n');
      put(path.join(wt, '.env'), 'API_KEY=fixture-only\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: .env ignored' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['.gitignore', 'app.js'], 'fixture: no capture took .env');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const { r, u } = await twoCalls(store, aid, wt, t0.id, 'E, an undo whose row\'s .gitignore names the person\'s .env');
      A.ok(!!(r && u && r.preRestoreId && u.preRestoreId) && !(await tree(aid, r.preRestoreId)).includes('.env') && !(await tree(aid, u.preRestoreId)).includes('.env'), 'E: neither capture took .env');
    });
    await runRows(rows, rowKit);
    {
      // this file runs past test/slow.list's 40 s rule, its rows four at a time since undo review 6 (slow.list says what it
      // takes, under what load and when); listed there, a gate gives it 600 s, not 120 s. It is a step of the fast gate,
      // not the HTTP gate, which has no minutes to spare (slow.list says why)
      const slow = fs.readFileSync(path.join(__dirname, 'slow.list'), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(slow.includes('test/checkpoint-undo.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.eq([steps('fast.list').includes('test/checkpoint-undo.test.js'), steps('http.list').includes('test/checkpoint-undo.test.js')], [true, false], 'and a step of the fast gate, not the HTTP gate');
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
