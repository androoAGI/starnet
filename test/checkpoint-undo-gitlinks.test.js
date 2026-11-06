/* node test/checkpoint-undo-gitlinks.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where the reset makes a folder over a FILE or
   records a gitlink (lane checkpoint-links, undo review 4, 2026-10-31; sidecar/checkpoint-store.js, the header's THE
   PROMISE and restore's THE UNDO ROW RESTORES THROUGH THIS API). The rows of undo reviews 1-3 are
   test/checkpoint-undo.test.js; these were split from it so each step keeps its room under test/slow.list's 600 s.

   Undo review 4 found, at b0f2ce5e, a completed rewind whose preRestoreId the API refused on every try, the person's edit
   since the last capture left in the undo row only (2d1c2fb9 the same):
     GF    the target recorded a gitlink where a FILE stands now (gf2: a clone at v, now the file v), or below a folder the
           reset makes over one (gf1: v/a.txt and a clone at v/sub, now the file v). Git wrote the gitlink as an empty
           folder, and the undo's check of the folder it must delete again counted that gitlink, which its index (the
           target's) records, as an embedded repository (uncaptured_in_path). Trunk d5024f5a, with no such check, undid
           it. Such a rewind is refused now (the store's gitlinkOverFile);
     H4    the undo lists in full (its link check, scan.linksBelow) a folder it prunes that the reset made over a FILE,
           counting levels from that folder, and its walk enters a gitlink's own empty folder, one level below the
           gitlink's parent: the rewind's depth check measured neither (link_check_failed). It measures both as the undo
           does now;
     N2    no row pinned N1's asking again (test/checkpoint-undo.test.js, ec728f61): nothing its cut-off listing left
           undecided was in the target's index, so a nestedRepos that never asks again passed every row. N2's target
           records Z (a `.git` junction, a linked worktree) as a gitlink its index lists after a long X.
   Undo review 5 found, at be7d99aa, the same stranded undo two more ways:
     SYM   a restore point a capture older than the lane recorded with a SYMBOLIC LINK (mode 120000: trunk d5024f5a's
           `add -A` took one): where Git makes links (POSIX) the rewind made it, ok:true, and the undo's link check took
           it for a link of the person's own (link_in_path) on every try (2d1c2fb9 the same). A rewind to or from a tree
           that records one is refused now, on every platform (the store's symlinkRefusal): sym1, sym2; sym5 where the
           listings of every record's mode pass the capped runner's limit; sym4, the undo's way round, and sym6, both
           trees recording the same link, where Git writes a link as a plain file and the shadow index keeps an older
           capture's link record for the plain file there (sym6's undo, after a person turned core.symlinks on, was
           refused by its own check);
     gf1c h4ac  no row pinned the case fold of a folder the reset makes over a FILE: a lookup by the target's own
           spelling passed every row and brought GF and H4 back where the FILE is spelled V or Gen.
   Undo review 6 found, at ab10c33a, a completed rewind that deleted, or wrote over, a FILE no capture took, its undo
   ok:true without it: where the shadow index still tracks paths below the FILE's name (a folder at the last capture),
   Git's index-aware check-ignore names nothing, so restoreUncapturedConflicts neither refused nor took it:
     IF1s IF2  the person's ignored FILE logs, the index tracking logs/a.txt from a capture before their rule: reset
           deleted it to write logs/a.txt (IF1s) or wrote T0's FILE logs over it (IF2), trunk d5024f5a the same;
     IF6 IF7  a FILE no rule of the work tree ignores, which only the target's rule names (IF6: logs, keptFile) or a
           folder above it (IF7: dist/sub below the rule dist, keptOut): left out of `add -A` by the capture's
           info/exclude line and deleted by reset (since 8808d408 and c8e20497; trunk d5024f5a took it and undid it).
     Git's rules alone are asked now (check-ignore --no-index): IF1s and IF2 are refused, untouched; IF6 and IF7 take
     the FILE by name, and both calls bring every path and byte back.
   The rows of undo reviews 7, 8 and 9 (names Git and the file system read apart, the bytes, the person's Git config, a Git
   killed from outside, a row an older store wrote) are test/checkpoint-undo-reads.test.js, a folder that reads case apart test/checkpoint-undo-case.test.js,
   split from this file at undo review 9 so each step keeps its room under test/slow.list's 600 s, rows, oracles and
   counts unchanged.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was); each refusal row has a control one step short of it that goes ahead both ways (gf3, h4c, h4ps, h4gc, h4acs,
   sym3; IF6 for IF1s and IF2: the same FILE, no rule of the work tree naming it). The rows run eight at a time
   (runRows): each owns its agent id, work tree, outside folders and its capped runner's list of cut-off listings, so
   none reads another's state or timing, and one that throws fails alone. The depth rows use a store walking 5 levels
   against a target recorded with the default depth, as an older store or a bigger budget records one (W depth,
   test/checkpoint-undo.test.js); N2 and sym5 use the real runner capped at 1500 bytes, N2 a 70-entry walk budget, as N1.
   Every row runs against a real temp work tree and real git (test/helpers/checkpoint-rows.js says how the rows run and
   how Git is started); the rows' Git reads no global config or attributes file of the person's.
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), a linked worktree of one, and a
   `.git` junction (Windows) or directory symlink (POSIX) to such a clone's .git, all inside this test's own os.tmpdir()
   folder; the link is removed with `cmd /c rmdir` (Windows) / unlink before the folder is deleted. A symbolic link
   record is written into the shadow repo with Git's plumbing (update-index --cacheinfo 120000), never made on disk. */
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

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-gitlinks-')));
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
// the same restore point's records ("<mode> <type> <sha>\t<path>" per line): a fixture's premise on what it records
function treeRecs(aid, id) {
  return gitRun(['--git-dir', gitDirOf(aid), 'ls-tree', '-r', String(id).split(':').pop()]);
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

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  // the real runner, its output limit 1500 bytes
  const cappedRunner = makeCheckpointGitRunner({ spawn: launchSpawn, maxBytes: 1500, clock: { now: () => Date.now() } });
  const verbOf = (args) => args.find((a) => /^(diff-index|diff-tree|ls-files|ls-tree|grep|cat-file|check-ignore)$/.test(a)) || '?';

  // a row's own kit: `cut` names the Git verbs its capped runner cut off since it was last emptied
  const rowKit = () => {
    const cut = [];
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
    return { cut: cut, twoCalls: twoCalls, refusedClean: refusedClean };
  };
  const rows = [];
  const row = (name, fn) => { rows.push({ name: name, fn: fn }); };

  try {
    const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    // ================= undo review 4: a gitlink recorded over a FILE, the depth the undo lists to, a cut answer asked again =================
    {
      // GF (the security BLOCKER; the review's G1 and G2): T records a clone as a gitlink, at v/sub beside v/a.txt (gf1) or
      // at v (gf2); since, the clone is gone and v is a FILE, app.js edited. The rewind went ahead: Git wrote the gitlink as
      // an empty folder over the file. Its undo, to a row holding the FILE v, had to delete that folder again, and its own
      // check of what that deletes counted the gitlink its index (T's) records there as an embedded repository: refused on
      // every try (uncaptured_in_path), app.js v2 and the file in the undo row only (2d1c2fb9 the same; trunk d5024f5a, with
      // no such check, undid it). Refused now, before the commit (the store's gitlinkOverFile). gf1u: the FILE no capture
      // took (the pre-restore capture takes it); gf1d: at lib/v; gf2c (where the file system folds case): the target's
      // gitlink V, the FILE v no capture took, so the tree the rewind stages spells it v (a capture of a file over the
      // gitlink keeps the index's V); gf1c (undo review 5's correctness MAJOR: no row pinned the case fold of the folders
      // the reset makes over a FILE, so a lookup by the target's own spelling passed every row): gf1 with the FILE spelled
      // V. gf3, the control: nothing at v now, both calls go ahead
      for (const [aid, at, gl, how, spelled] of [['gf1', 'v', 'v/sub', 'captured'], ['gf1c', 'v', 'v/sub', 'captured', 'V'], ['gf1u', 'v', 'v/sub', 'uncaptured'],
        ['gf1d', 'lib/v', 'lib/v/sub', 'captured'], ['gf2', 'v', 'v', 'captured'], ['gf2c', 'v', 'V', 'uncaptured'], ['gf3', 'v', 'v', 'none']]) row(aid, async ({ twoCalls, refusedClean }) => {
        if ((aid === 'gf2c' || aid === 'gf1c') && !foldsCase) { console.log('[skip] ' + aid + ': this file system does not fold case'); return; }
        const wt = path.join(ROOT, aid), file = spelled || at;    // the FILE as the work tree spells it
        put(path.join(wt, 'app.js'), 'v0\n');
        if (gl.length > at.length) put(path.join(wt, at, 'a.txt'), 'a in T\n');
        await clone(path.join(wt, gl), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at ' + gl });
        A.ok(!!t && new RegExp('^160000 commit [0-9a-f]+\\t' + esc(gl) + '$', 'm').test(await treeRecs(aid, t.id)), 'fixture (' + aid + '): T records ' + gl + ' as a gitlink');
        fs.rmSync(path.join(wt, gl.length > at.length ? at : gl), { recursive: true, force: true });
        if (how === 'captured') put(path.join(wt, file), file + ' is a FILE now\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        A.eq([!!(s1 && s1.created), !!s1 && (await tree(aid, s1.id)).includes(file)], [true, how === 'captured'], 'fixture (' + aid + '): S1 ' + (how === 'captured' ? 'holds' : 'lacks') + ' ' + file);
        if (how === 'uncaptured') put(path.join(wt, file), file + ' is a FILE no capture took\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (how === 'none') { await twoCalls(store, aid, wt, t.id, 'gf3, a rewind that records a gitlink where nothing stands'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', new RegExp('^"' + esc(file) + '" is a file now, and the restore point records an embedded Git repository \\(a gitlink\\) '
          + (gl.length > at.length ? 'at "' + esc(gl) + '", inside the folder it holds there' : 'at that path') + ': .* which its undo could not turn back into the file'),
        aid + ', a rewind that would record the gitlink ' + gl + ' where ' + (how === 'uncaptured' ? 'an uncaptured' : 'the') + ' FILE ' + file + ' stands');
      });
    }
    {
      // H4 (the security BLOCKER: a store walking 5 levels, T recorded with the default depth, as W depth). The undo lists
      // in full a folder it prunes that the reset made over a FILE of its row (its link check: scan.linksBelow), counted
      // from that folder, and the rewind's depth check skipped every write below a folder the undo prunes: h4a, T's gen/
      // with folders six deep in it, below T's rule gen, now the FILE gen; h4b, the rule in the undo row's own .gitignore;
      // h4cd, the FILE a turned into a/ holding a pruned node_modules with folders six deep in it; h4p, the FILE
      // node_modules/x, inside a pruned node_modules, turned into a folder with folders six deep in it. And it measured a
      // gitlink by its parent folders, while Git makes the gitlink's own empty folder there and the undo's walk enters it:
      // h4g, a clone at a/b/c/d/e/f with nothing there now; h4g2, a/b/c/d/e there. Each rewind went ahead and its undo
      // was refused (link_check_failed), app.js v2 in the undo row only (2d1c2fb9 the same). Refused now, before the
      // commit. The controls, one level less, both calls: h4c, h4ps (measured from x, the FILE's folder inside the pruned
      // node_modules, as the undo lists it), h4gc (a/b/c/d kept, holding keep.txt: since undo review 11 a rewind that makes the
      // folders a gitlink is recorded in is refused, checkpoint-undo-case mg, and the reset makes here only the gitlink's own)
      const st5 = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxDepth: 5 });
      const tooDeep = /^its undo would have to check folders nested deeper than 5 levels/;
      row('h4a', async ({ refusedClean }) => {
        const aid = 'h4a', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'gen', 'a', 'b', 'c', 'd', 'e', 'f', 'x.txt'), 'deep generated\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: gen tracked' });
        put(path.join(wt, '.gitignore'), 'gen\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: gen ignored, still tracked' });
        fs.rmSync(path.join(wt, 'gen'), { recursive: true });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        put(path.join(wt, 'gen'), 'gen is a FILE now\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st5.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: gen a file, no rule' });
        A.ok(!!(t && s1 && s1.created) && (await tree(aid, t.id)).includes('gen/a/b/c/d/e/f/x.txt') && (await tree(aid, s1.id)).includes('gen'), 'fixture (h4a): T tracks gen/, its folders six deep, below its rule; S1 holds the FILE gen');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, 'h4a, a rewind that makes a pruned gen/ over the FILE gen, its folders six deep (depth 5)');
      });
      // h4ac (undo review 5's correctness MAJOR, as gf1c): h4a with the FILE spelled Gen, where the file system folds case.
      // The depth is measured from the folder the undo's link check lists in full only where the reset's folder is found
      // over that FILE in any case; by the target's own spelling the rewind went ahead and its undo was refused
      // (link_check_failed). h4acs, the control five deep, both calls
      for (const [aid, dirs, refused] of [['h4ac', ['a', 'b', 'c', 'd', 'e', 'f'], true], ['h4acs', ['a', 'b', 'c', 'd', 'e'], false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        if (!foldsCase) { console.log('[skip] ' + aid + ': this file system does not fold case'); return; }
        const wt = path.join(ROOT, aid), deep = ['gen'].concat(dirs, ['x.txt']).join('/');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, deep), 'deep generated\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: gen tracked' });
        put(path.join(wt, '.gitignore'), 'gen\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: gen ignored, still tracked' });
        fs.rmSync(path.join(wt, 'gen'), { recursive: true });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        put(path.join(wt, 'Gen'), 'Gen is a FILE now\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st5.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: Gen a file, no rule' });
        A.ok(!!(t && s1 && s1.created) && (await tree(aid, t.id)).includes(deep) && (await tree(aid, s1.id)).includes('Gen'), 'fixture (' + aid + '): T tracks gen/, its folders ' + dirs.length + ' deep, below its rule; S1 holds the FILE Gen');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that makes a pruned gen/ over the FILE Gen, its folders ' + dirs.length + ' deep (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      });
      row('h4b', async ({ refusedClean }) => {
        const aid = 'h4b', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'gen', 'a', 'b', 'c', 'd', 'e', 'f', 'x.txt'), 'deep generated\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: gen tracked, no rule' });
        fs.rmSync(path.join(wt, 'gen'), { recursive: true });
        put(path.join(wt, 'gen'), 'gen is a FILE now\n');
        await st5.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: gen a file' });
        put(path.join(wt, '.gitignore'), 'gen\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s2 = await st5.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: the rule gen, gen a tracked file' });
        const held2 = s2 ? await tree(aid, s2.id) : [];
        A.ok(!!(t && s2 && s2.created) && held2.includes('gen') && held2.includes('.gitignore'), 'fixture (h4b): the undo row\'s .gitignore lists gen, and it holds the FILE gen');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, 'h4b, the same with the rule in the undo row\'s own .gitignore (depth 5)');
      });
      for (const [aid, dirs, refused] of [['h4cd', ['p', 'q', 'r', 's', 't', 'w'], true], ['h4c', ['p', 'q', 'r', 's', 't'], false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join.apply(path, [wt, 'a', 'node_modules'].concat(dirs, ['u.js'])), 'deep dep\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: a/node_modules tracked' });
        put(path.join(wt, '.gitignore'), 'node_modules\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: node_modules ignored, still tracked' });
        fs.rmSync(path.join(wt, 'a'), { recursive: true });
        put(path.join(wt, 'a'), 'a is a FILE now\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st5.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: a a FILE, the rule kept' });
        A.ok(!!(t && s1 && s1.created) && (await tree(aid, s1.id)).includes('a'), 'fixture (' + aid + '): S1 holds the FILE a');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that turns the FILE a into a/ holding a pruned node_modules, its folders ' + dirs.length + ' deep (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      });
      for (const [aid, dirs, refused] of [['h4p', ['a', 'b', 'c', 'd', 'e', 'f'], true], ['h4ps', ['a', 'b', 'c', 'd', 'e'], false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid), x = path.join(wt, 'node_modules', 'x');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join.apply(path, [x].concat(dirs, ['y.js'])), 'deep dep\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: node_modules/x tracked' });
        put(path.join(wt, '.gitignore'), 'node_modules\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: the rule, node_modules/x still tracked' });
        fs.rmSync(x, { recursive: true });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        put(x, 'x is a FILE now\n');
        await st5.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no rule, x a FILE' });
        put(path.join(wt, '.gitignore'), 'node_modules\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s2 = await st5.snapshot(aid, { runId: 'r', turn: 3, label: 'S2: the rule again, x still tracked' });
        const held2 = s2 ? await tree(aid, s2.id) : [];
        A.ok(!!(t && s2 && s2.created) && held2.includes('node_modules/x') && held2.includes('.gitignore'), 'fixture (' + aid + '): the undo row holds the FILE node_modules/x below its rule');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that turns the FILE node_modules/x, in a pruned folder, into a folder, its folders ' + dirs.length + ' deep (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      });
      for (const [aid, at, keep, refused] of [['h4g', 'a/b/c/d/e/f', '', true], ['h4g2', 'a/b/c/d/e/f', 'a/b/c/d/e/keep.txt', true], ['h4gc', 'a/b/c/d/e', 'a/b/c/d/keep.txt', false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        if (keep) put(path.join(wt, keep), 'keep\n');
        await clone(path.join(wt, at), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at ' + at });
        A.ok(!!t && new RegExp('^160000 commit [0-9a-f]+\\t' + esc(at) + '$', 'm').test(await treeRecs(aid, t.id)), 'fixture (' + aid + '): T records ' + at + ' as a gitlink');
        fs.rmSync(path.join(wt, keep ? at : 'a'), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st5.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no clone' });
        A.ok(!!(s1 && s1.created), 'fixture (' + aid + '): S1 recorded by the store walking 5 levels');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that records the gitlink ' + at + (keep ? ', its folder ' + at.split('/').slice(0, -1).join('/') + ' there' : '') + ' (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      });
    }
    {
      // N2 (the correctness MAJOR: N1 never pinned ec728f61's asking again, as nothing its cut-off listing left undecided
      // was in the target's index; a mutant that never asks again passed every row). T, recorded with no output limit,
      // tracks X/ of 30 long names and records Z as a gitlink: a folder whose .git is a junction to a sibling repository
      // (n2j), or a linked worktree of one (n2w). Z then gets 60 files, which S1's walk skips (its index names the gitlink),
      // and X keeps two files and gets a `git init`; the real runner capped at 1500 bytes, budget 70. The undo's question
      // which of X and Z are repositories, asked of its index (T's), is cut off inside X before Z's record: Z, asked again,
      // is a gitlink, and the undo's walk skips it as the rewind's did. Without asking again (2d1c2fb9, c8e20497) its walk
      // took Z for a plain folder and entered it, past the count its rewind took (link_check_failed)
      for (const kind of ['junction', 'worktree']) row('n2' + kind[0], async ({ cut, twoCalls }) => {
        const aid = 'n2' + kind[0], wt = path.join(ROOT, aid), X = path.join(wt, 'X'), Z = path.join(wt, 'Z'), main = path.join(BASE, aid + '-main');
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 30; i++) put(path.join(X, 'x' + flatName(i).slice(0, 30)), 'x' + i + '\n');
        await clone(main, { 'README': 'main\n' });
        if (kind === 'worktree') await gitRun(ident.concat(['worktree', 'add', '-q', '--detach', Z]), { cwd: main });
        else { fs.mkdirSync(Z); link(path.join(main, '.git'), path.join(Z, '.git')); put(path.join(Z, 'README'), 'main\n'); }
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: X with 30 files, Z a gitlink' });
        A.ok(!!t && /^160000 [0-9a-f]+ 0\tZ$/m.test((await gitIn(aid, ['ls-files', '-s', '--', 'Z'])).out), 'fixture (' + aid + '): T records Z as a gitlink');
        for (let i = 0; i < 60; i++) put(path.join(Z, 'src', 'm' + i + '.js'), 'module ' + i + '\n');
        for (let i = 2; i < 30; i++) fs.unlinkSync(path.join(X, 'x' + flatName(i).slice(0, 30)));
        await gitRun(['init', '-q'], { cwd: X });
        put(path.join(wt, 'app.js'), 'v1\n');
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, scanMaxEntries: 70,
          runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: X two files and a .git, Z still a gitlink (60 files skipped)' });
        A.eq([t && t.files, s1 && s1.created && s1.files], [32, 4], 'fixture (' + aid + '): T tracks 30 files in X and Z; S1 two in X, Z, app.js');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const outside = listing(main);
        const { undoCut } = await twoCalls(st, aid, wt, t.id, 'N2 (' + kind + '), an undo whose index lists the gitlink Z after a long X');
        A.ok(undoCut.includes('ls-files'), 'fixture (' + aid + '): the undo\'s question of which folders are repositories passed the limit (' + JSON.stringify(undoCut) + ')');
        A.eq(listing(main), outside, 'N2 (' + kind + '): the repository outside the workspace that Z\'s .git leads to is untouched, every path and byte');
      });
    }
    // ================= undo review 5: a symbolic link a capture older than the lane recorded =================
    {
      // SYM (the security BLOCKER): a capture before the lane's link boundary (trunk d5024f5a's `add -A`) recorded lib, a
      // symbolic link to ../shared-lib (mode 120000: written here with Git's own plumbing, as such a capture records it;
      // the restore list rebuilt from the shadow history, as after an upgrade). Where Git makes links (POSIX) the rewind
      // made that link, ok:true, and its undo's link check took it for one of the person's own: link_in_path on every try,
      // the captured lib/a.js and lib/b.js, the edit since and app.js v2 in the undo row only (2d1c2fb9 and be7d99aa the
      // same; trunk d5024f5a, with no link check, undid it). A rewind to or from a tree that records a symbolic link is
      // refused now, before the commit, on every platform (the store's symlinkRefusal): sym1, lib/ a folder of captured
      // files now, one edited since; sym2, nothing at lib. sym3, the control: T records lib as a plain file, both calls
      // go ahead
      const symAhead = /^"lib" is a symbolic link in the restore point \(a capture older than the checkpoint's link check recorded it\): rewinding to it could make that link/;
      const hashOf = async (aid, rel) => (await gitIn(aid, ident.concat(['hash-object', '-w', '--', rel]))).out.trim();
      const rebuiltRow = async (st, aid, sha) => {         // the restore list rebuilt from the shadow history, as after an upgrade
        for (const f of ['index.json', 'index.json.bak']) { try { fs.unlinkSync(path.join(ROOT, '.checkpoints', aid, f)); } catch (_) {} }
        return (await st.listResilient(aid)).snapshots.find((s) => s.id === sha) || null;
      };
      const symTarget = async (aid, wt, mode, extra) => {  // T: app.js v0 and lib recorded with `mode` (an older capture's record)
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'lib'), '../shared-lib');
        for (const [rel, body] of Object.entries(extra || {})) put(path.join(wt, rel), body);
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: lib a plain file' });
        await gitIn(aid, ['update-index', '--cacheinfo', mode + ',' + (await hashOf(aid, 'lib')) + ',lib']);
        await gitIn(aid, ident.concat(['commit', '-q', '--allow-empty', '-m', 'T: an older capture']));
        const sha = (await gitIn(aid, ['rev-parse', 'HEAD'])).out.trim();
        A.ok(new RegExp('^' + mode + ' blob [0-9a-f]+\\tlib$', 'm').test(await treeRecs(aid, sha)), 'fixture (' + aid + '): T records lib as ' + (mode === '120000' ? 'a symbolic link' : 'a plain file'));
        return sha;
      };
      for (const [aid, mode, held] of [['sym1', '120000', true], ['sym2', '120000', false], ['sym3', '100644', true]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        const sha = await symTarget(aid, wt, mode);
        fs.unlinkSync(path.join(wt, 'lib'));
        if (held) { put(path.join(wt, 'lib', 'a.js'), 'lib a, captured\n'); put(path.join(wt, 'lib', 'b.js'), 'lib b, captured\n'); }
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        const t = await rebuiltRow(store, aid, sha);
        const held1 = s1 ? await tree(aid, s1.id) : [];
        A.ok(!!(s1 && s1.created && t) && held1.includes('app.js') && held1.includes('lib/a.js') === held, 'fixture (' + aid + '): S1 recorded ' + (held ? 'with' : 'without') + ' lib/, and T a row of the rebuilt restore list');
        if (held) put(path.join(wt, 'lib', 'a.js'), 'lib a EDITED, no snapshot took this\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind to a point that records lib as ' + (mode === '120000' ? 'a symbolic link' : 'a plain file') + (held ? ', a folder of files there now' : ', nothing there now');
        if (mode !== '120000') { await twoCalls(store, aid, wt, (t && t.id) || '', label); return; }
        await refusedClean(store, aid, wt, (t && t.id) || '', 'link_in_path', symAhead, label);
        if (aid !== 'sym1') return;
        // a Git older than 2.36 (no ls-tree --format): every record of T is listed, and the rewind is refused the same; and
        // where Git cannot list them at all, refused untouched too (link_check_failed)
        const oldGit = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
          runGit: (args, opts) => (args.indexOf('ls-tree') >= 0 && args.some((a) => /^--format=/.test(a)) ? Promise.resolve({ code: 129, stdout: '', stderr: 'error: unknown option `format\'' }) : runGit(args, opts)) });
        await refusedClean(oldGit, aid, wt, (t && t.id) || '', 'link_in_path', symAhead, 'sym1 through a Git with no ls-tree --format');
        const noTree = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
          runGit: (args, opts) => (args.indexOf('ls-tree') >= 0 && args.indexOf('-r') >= 0 ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: failed on purpose' }) : runGit(args, opts)) });
        await refusedClean(noTree, aid, wt, (t && t.id) || '', 'link_check_failed', /^the files of the restore point could not be listed to check them for symbolic links$/, 'sym1 where Git cannot list the trees\' records');
      });
      row('sym5', async ({ cut, refusedClean }) => {
        // sym5: the same through the real runner capped at 1500 bytes, T holding 230 more files in 20 folders of data/: its
        // listing of every record's mode passes the limit before lib's (seven bytes an entry), and so does the one with
        // their paths, and a cut-off listing is never read as "no link": every record of T is listed, split under the limit
        // (a folder whose own entry list passed it would refuse the rewind, link_check_failed), and the rewind is refused
        const aid = 'sym5', wt = path.join(ROOT, aid), more = {};
        for (let i = 0; i < 230; i++) more['data/d' + (i % 20) + '/f' + String(i).padStart(3, '0') + '.txt'] = 'd' + i + '\n';
        const sha = await symTarget(aid, wt, '120000', more);
        fs.unlinkSync(path.join(wt, 'lib'));
        put(path.join(wt, 'lib', 'a.js'), 'lib a, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        const t = await rebuiltRow(store, aid, sha);
        A.ok(!!(s1 && s1.created && t) && (await tree(aid, s1.id)).length === 232, 'fixture (sym5): S1 holds app.js, lib/a.js and the 230 files, and T is a row');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
          runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
        cut.length = 0;
        await refusedClean(st, aid, wt, (t && t.id) || '', 'link_in_path', symAhead, 'sym5, the same where the listing of every mode passes the runner\'s limit');
        A.ok(cut.includes('ls-tree'), 'fixture (sym5): the listing of every record\'s mode passed the limit (' + JSON.stringify(cut) + ')');
      });
      // where Git writes a link as a plain file (core.symlinks false, Windows' usual) the shadow index keeps an older
      // capture's link record for the plain file lib standing there, so the tree a rewind's capture stages records lib as
      // a link. sym4, the undo's way round: the rewind to a point without lib deletes it, and its undo, which writes that
      // record back, would be refused by sym1's own check on every try, the file and app.js v2 left in the undo row only.
      // sym6: T and S1 both record lib as that same link, and the rewind changes app.js alone: a person who turns
      // core.symlinks on before its undo (developer mode) makes the undo's capture record lib as a file, and the undo's
      // check, its target's link where it writes, refused it. So each rewind is refused, before its commit
      for (const [aid, both] of [['sym4', false], ['sym6', true]]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: no lib' });
        if ((await gitIn(aid, ['config', '--get', 'core.symlinks'])).out.trim() !== 'false') { console.log('[skip] ' + aid + ': Git makes links here (core.symlinks), so a capture keeps no link record for a plain file'); return; }
        put(path.join(wt, 'lib'), '../shared-lib');
        await gitIn(aid, ['update-index', '--add', '--cacheinfo', '120000,' + (await hashOf(aid, 'lib')) + ',lib']);
        const t1 = both ? await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T1: the plain file lib, recorded as a link' }) : null;
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: the plain file lib, recorded as a link' });
        const t = both ? t1 : t0, linkRec = /^120000 blob [0-9a-f]+\tlib$/m;
        A.ok(!!(t && s1 && s1.created) && linkRec.test(await treeRecs(aid, s1.id)) && linkRec.test(await treeRecs(aid, t.id)) === both,
          'fixture (' + aid + '): S1' + (both ? ' and T both record' : ' records') + ' the plain file lib as a symbolic link, as the shadow index kept it');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'link_in_path', both ? symAhead : /^"lib" is recorded as a symbolic link in the files rewinding would save as its undo .*: its undo could make that link/,
          aid + (both ? ', a rewind between two points that record the plain file lib as the same symbolic link' : ', a rewind that would delete the plain file lib its capture records as a symbolic link'));
      });
    }
    // ================= undo review 6: what no capture took, where the shadow index still tracks paths below its name =================
    {
      // IF1s, IF2 (the security BLOCKER, older than the lane: trunk d5024f5a lost the same file): the person's FILE logs,
      // which their own .gitignore ignores, stands where the shadow index still tracks logs/a.txt (captured before the
      // rule). Git's index-aware check-ignore names nothing the index tracks a path below, so the file read as one `add -A`
      // takes; `add -A` left it out (the rule), and the reset deleted it to write logs/a.txt (IF1s: rewinding to the latest
      // capture, no rule changed) or wrote T0's FILE logs over it (IF2), ok:true, and its undo was ok:true without it.
      // Asked of the rules alone now (check-ignore --no-index): refused, untouched
      for (const aid of ['if1s', 'if2']) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid), toFile = aid === 'if2';
        put(path.join(wt, 'app.js'), 'v0\n');
        if (toFile) put(path.join(wt, 'logs'), 'T0\'s logs, a FILE\n');
        const t0 = toFile ? await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T0: the FILE logs' }) : null;
        if (toFile) fs.unlinkSync(path.join(wt, 'logs'));
        put(path.join(wt, 'logs', 'a.txt'), 'a, captured\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'logs/a.txt captured, no rule' });
        put(path.join(wt, '.gitignore'), 'logs\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: logs ignored, logs/a.txt still tracked' });
        fs.rmSync(path.join(wt, 'logs'), { recursive: true });
        put(path.join(wt, 'logs'), 'the person\'s logs FILE, ignored, no capture took this\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        A.eq([!!(s1 && s1.created) && (await tree(aid, s1.id)).includes('logs/a.txt'), (await gitIn(aid, ['ls-files', '--', 'logs'])).out, (await gitIn(aid, ['check-ignore', 'logs'])).code, (await gitIn(aid, ['check-ignore', '--no-index', 'logs'])).out],
          [true, 'logs/a.txt\n', 1, 'logs\n'], 'fixture (' + aid + '): the shadow index still tracks logs/a.txt below the rule, so Git\'s index-aware check-ignore names nothing, and its rules alone name the FILE logs');
        await refusedClean(store, aid, wt, toFile ? t0.id : s1.id, 'uncaptured_in_path', toFile
          ? /^"logs" as it is now is in no restore point \(Git ignores it\), and the restore point holds a file at that path: rewinding would replace it/
          : /^"logs" as it is now is in no restore point \(Git ignores it\), and the restore point holds a folder at that path: rewinding would delete it/,
        aid + ', a rewind that would ' + (toFile ? 'write T0\'s FILE logs over' : 'delete, for logs/a.txt,') + ' the person\'s ignored FILE logs while the index tracks logs/a.txt');
      });
      // IF6, IF7 (the security BLOCKER, this lane's: since 8808d408 a folder only the target's rules name is kept out of the
      // capture by an info/exclude line, since c8e20497 a FILE): the person's FILE, which no rule of the work tree ignores,
      // stands where the shadow index still tracks paths below its name, and only the target's .gitignore names it (IF6:
      // the FILE logs, keptFile) or a folder above it (IF7: the FILE dist/sub below the rule dist, keptOut). Git's
      // index-aware check-ignore named nothing, so it was neither refused nor taken by name, `add -A` left it out by that
      // line, and the reset deleted it to write the target's file there, ok:true, its undo ok:true without it (trunk
      // d5024f5a and 2d1c2fb9 took it and undid it). Asked of the rules alone now: the capture takes it by name (forced),
      // and both calls bring every path and byte back
      row('if6', async ({ twoCalls }) => {
        const aid = 'if6', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'logs', 'a.txt'), 'a, captured\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: logs/a.txt captured' });
        put(path.join(wt, '.gitignore'), 'logs\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: logs ignored, logs/a.txt still tracked' });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        put(path.join(wt, 'app.js'), 'v1\n');
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: no rule, logs/a.txt still tracked' });
        fs.rmSync(path.join(wt, 'logs'), { recursive: true });
        put(path.join(wt, 'logs'), 'the person\'s logs FILE, no capture took this\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        A.eq([!!(t && s2 && s2.created) && (await tree(aid, t.id)).includes('logs/a.txt'), (await gitIn(aid, ['ls-files', '--', 'logs'])).out, (await gitIn(aid, ['check-ignore', '--no-index', 'logs'])).code],
          [true, 'logs/a.txt\n', 1], 'fixture (if6): T ignores logs and tracks logs/a.txt, the shadow index still tracks it, and no rule of the work tree ignores the FILE logs');
        const { r, mid } = await twoCalls(store, aid, wt, t.id, 'if6, a rewind that writes logs/a.txt where the person\'s FILE logs stands, only the target\'s .gitignore naming it');
        A.eq([mid['logs/a.txt'], !!(r && r.preRestoreId) && (await tree(aid, r.preRestoreId)).includes('logs')], ['a, captured\n', true], 'if6: the rewind wrote the target\'s logs/a.txt, and its undo row holds the FILE logs, taken by name');
      });
      row('if7', async ({ twoCalls }) => {
        const aid = 'if7', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'dist', 'sub', 'a.txt'), 'a, captured\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: dist/sub/a.txt captured' });
        put(path.join(wt, '.gitignore'), 'dist\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: dist ignored, dist/sub/a.txt still tracked' });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        fs.unlinkSync(path.join(wt, 'dist', 'sub', 'a.txt'));
        put(path.join(wt, 'dist', 'sub', 'x.txt'), 'x, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: no rule, dist/sub/x.txt tracked' });
        fs.rmSync(path.join(wt, 'dist', 'sub'), { recursive: true });
        put(path.join(wt, 'dist', 'sub'), 'the person\'s FILE dist/sub, no capture took this\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        A.eq([!!(t && s2 && s2.created) && (await tree(aid, t.id)).includes('dist/sub/a.txt'), (await gitIn(aid, ['ls-files', '--', 'dist/sub'])).out, (await gitIn(aid, ['check-ignore', '--no-index', 'dist/sub'])).code],
          [true, 'dist/sub/x.txt\n', 1], 'fixture (if7): T ignores dist and tracks dist/sub/a.txt, the shadow index tracks dist/sub/x.txt, and no rule of the work tree ignores the FILE dist/sub');
        const { r, mid } = await twoCalls(store, aid, wt, t.id, 'if7, a rewind that writes dist/sub/a.txt where the person\'s FILE dist/sub stands, in a folder only the target\'s .gitignore names');
        A.eq([mid['dist/sub/a.txt'], !!(r && r.preRestoreId) && (await tree(aid, r.preRestoreId)).includes('dist/sub')], ['a, captured\n', true], 'if7: the rewind wrote the target\'s dist/sub/a.txt, and its undo row holds the FILE dist/sub, taken by name');
      });
    }
    // the rows' Git reads no attributes file or global config of the person's, wherever this box keeps one
    process.env.XDG_CONFIG_HOME = path.join(BASE, 'no-config-home');
    process.env.GIT_CONFIG_GLOBAL = path.join(BASE, 'no-gitconfig');
    await runRows(rows, rowKit);
    {
      // this file runs past test/slow.list's 40 s rule, its rows four at a time since undo review 6 (slow.list says what it
      // takes, under what load and when); listed there, a gate gives it 600 s, not 120 s. Its rows were split from
      // test/checkpoint-undo.test.js so that file keeps that much room too. A step of the fast gate, beside it
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-gitlinks.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-gitlinks.test.js'), steps('http.list').includes('test/checkpoint-undo-gitlinks.test.js')], [true, false], 'and a step of the fast gate, not the HTTP gate');
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
  A.report('checkpoint-undo-gitlinks.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-gitlinks.test threw — ' + (e && e.stack || e)); process.exit(1); });
