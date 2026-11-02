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
   Undo review 7 found, at 211c69d1, each with both calls ok:true unless it says otherwise (each block below says more):
     uw ud ur us1 uu uboth  a name spelled apart in a letter outside A-Z, which Git's fold reads as two and the file system as
           one: a rewind and its undo wrote and deleted through a junction, or emptied its target; a snapshot stored the outside
           bytes; a respelled file answered git_failed from both calls. Refused now, and listed by the walk's fold;
     snw snf snr snd sns1 snc  a Windows short name, which no listing shows and no fold reads. A rewind to or from a tree that
           records one's shape is refused now, on Windows, whatever stands there;
     at1-at7 atold atri gat gfl  .gitattributes (or the person's core.attributesFile): the bytes a capture stored and a rewind wrote were
           not the person's or T's. The shadow repo's own info/attributes turns every conversion off now;
     m1 m3 m4 mc mc2  a .gitmodules `ignore = all` hid a gitlink from the rewind's write and removal lists: --ignore-submodules=none;
     g2 gis gfm ghk  the person's global Git config: submodule.recurse, core.ignoreStat, core.fsmonitor, core.hooksPath, pinned now;
     lf1 lf2 lf3 atfail  a Git launch that failed answered code 1, which check-ignore and grep read as an answer of their own.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was); each refusal row has a control one step short of it that goes ahead both ways (gf3, h4c, h4ps, h4gc, h4acs,
   sym3; IF6 for IF1s and IF2: the same FILE, no rule of the work tree naming it). The rows run four at a time
   (runRows): each owns its agent id, work tree, outside folders and its capped runner's list of cut-off listings, so
   none reads another's state or timing, and one that throws fails alone. The depth rows use a store walking 5 levels
   against a target recorded with the default depth, as an older store or a bigger budget records one (W depth,
   test/checkpoint-undo.test.js); N2, sym5, ucap0-ucap3 use the real runner capped at 1500 bytes, N2 a 70-entry walk budget,
   as N1; the config rows give the real runner a spawn that sets GIT_CONFIG_GLOBAL for its own Git alone, and the launch
   rows one that starts a program that does not exist for one Git verb. Every row runs against a real temp work tree and
   real git (test/helpers/checkpoint-rows.js says how the rows run and how Git is started).
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
      // node_modules, as the undo lists it), h4gc
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
      for (const [aid, at, keep, refused] of [['h4g', 'a/b/c/d/e/f', '', true], ['h4g2', 'a/b/c/d/e/f', 'a/b/c/d/e/keep.txt', true], ['h4gc', 'a/b/c/d/e', '', false]]) row(aid, async ({ twoCalls, refusedClean }) => {
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
    // ================= undo review 7: names Git and the file system read apart, the bytes, the person's Git config, a failed launch =================
    const outsideOf = (aid) => {
      const out = path.join(BASE, aid + '-outside');
      put(path.join(out, 'x.txt'), 'OUTSIDE x: no part of this work tree\n');
      put(path.join(out, 'other.txt'), 'OUTSIDE other\n');
      put(path.join(out, 'deep', 'y.txt'), 'OUTSIDE y\n');
      return out;
    };
    const noFold = (aid) => { if (foldsCase) return false; console.log('[skip] ' + aid + ': this file system does not fold case'); return true; };
    const apart = /one name to the file system and two to Git/;
    {
      // NAMES OUTSIDE A-Z (the security BLOCKER and MAJOR). Git's pathspec icase and its name hash fold A-Z alone; NTFS and the
      // store's foldPath fold every letter that has a case, so a lookup of the junction uebung (u-umlaut) by Git's fold missed
      // the tracked Uebung/x.txt (U-umlaut), and Cyrillic the same. uw1 uw2: T holds the folder, a junction in the other case
      // stands now: the reset wrote through it and the undo's reset deleted the outside x.txt and the junction, ok:true on both
      // calls. ud1 ud2: the index still tracks it, T lacks it: the same. ur3 ur3c: T holds a FILE in the other case, the folder
      // holds a junction no ignore rule keeps out: the reset emptied the junction's target. us1: a plain snapshot stored the
      // outside bytes as Uebung/x.txt. uu1 uu2 (the MAJOR): the respelled file came back from both calls as git_failed, "could
      // not be removed", every byte in place. uboth: a tree holding both spellings (a capture of a respelled folder keeps the
      // index's and adds the disk's; a respelled FILE only where core.fscache is off) writes one file twice, and the undo would
      // find the name it wrote in the other spelling. ur5: only a junction in that folder, so no tree spells it, the disk alone.
      // Each is refused now, before the commit (the store's namesReadApart), and what the walk and Git read as one is listed by
      // the walk's fold (listUnder). uok, the control: such names, spelled alike everywhere, with a tilde and a digit in names
      // no short name has, go ahead both ways. ucap0-ucap3: the real runner capped at 1500 bytes: a listing of such names
      // past it refuses the rewind and skips the capture, and one under it goes ahead
      const LATIN = ['Übung', 'übung'], CYRILLIC = ['Папка', 'папка'];
      for (const [aid, pair] of [['uw1', LATIN], ['uw2', CYRILLIC]]) row(aid, async ({ refusedClean }) => {
        if (noFold(aid)) return;
        const [up, lo] = pair, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + up + '/x.txt' });
        fs.rmSync(path.join(wt, up), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the folder gone' });
        link(out, path.join(wt, lo));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        A.eq((await gitIn(aid, ['ls-files', '--with-tree=' + t.id, '--', ':(literal,icase)' + lo])).out, '', 'fixture (' + aid + '): Git\'s own fold does not read the junction ' + lo + ' as T\'s ' + up);
        const seen = listing(out);
        await refusedClean(store, aid, wt, t.id, 'link_in_path', /is a link \(a junction, symbolic link or mount point\), and rewinding would write or delete/, aid + ', a rewind that would write ' + up + '/x.txt through the junction ' + lo);
        A.eq(listing(out), seen, aid + ': every path and byte outside the work tree is untouched');
      });
      for (const [aid, pair] of [['ud1', LATIN], ['ud2', CYRILLIC]]) row(aid, async ({ refusedClean }) => {
        if (noFold(aid)) return;
        const [up, lo] = pair, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing there' });
        put(path.join(wt, up, 'x.txt'), 'S x\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: ' + up + '/x.txt tracked' });
        fs.rmSync(path.join(wt, up), { recursive: true });
        link(out, path.join(wt, lo));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        await refusedClean(store, aid, wt, t.id, 'link_in_path', /is a link \(a junction, symbolic link or mount point\), and rewinding would write or delete/, aid + ', a rewind that would delete ' + up + '/x.txt through the junction ' + lo);
        A.eq(listing(out), seen, aid + ': every path and byte outside the work tree is untouched');
      });
      for (const [aid, pair] of [['ur3', LATIN], ['ur3c', CYRILLIC]]) row(aid, async ({ refusedClean }) => {
        if (noFold(aid)) return;
        const [up, lo] = pair, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up), 'T: the FILE\n');
        put(path.join(wt, '.gitignore'), '!lnk\n');          // no ignore rule keeps the junction out, on either side
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE ' + up });
        fs.rmSync(path.join(wt, up));
        put(path.join(wt, lo, 'plain.txt'), 'plain\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the folder ' + lo });
        link(out, path.join(wt, lo, 'lnk'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apart, aid + ', a rewind that would replace the folder ' + lo + ', a junction in it, with the FILE ' + up);
        A.eq(listing(out), seen, aid + ': every path and byte outside the work tree is untouched');
      });
      row('ur5', async ({ refusedClean }) => {
        const aid = 'ur5';
        if (noFold(aid)) return;
        const [up, lo] = LATIN, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up), 'T: the FILE\n');
        put(path.join(wt, '.gitignore'), '!lnk\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE ' + up });
        fs.rmSync(path.join(wt, up));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the FILE gone' });
        fs.mkdirSync(path.join(wt, lo));
        link(out, path.join(wt, lo, 'lnk'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apart, 'ur5, a rewind that would replace the folder ' + lo + ', only a junction in it, with the FILE ' + up);
        A.eq(listing(out), seen, 'ur5: every path and byte outside the work tree is untouched');
      });
      row('us1', async () => {
        const aid = 'us1';
        if (noFold(aid)) return;
        const [up, lo] = LATIN, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'x.txt'), 'T x\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + up + '/x.txt' });
        fs.rmSync(path.join(wt, up), { recursive: true });
        link(out, path.join(wt, lo));
        put(path.join(wt, 'app.js'), 'v1\n');
        const s = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S: a junction in the other case' });
        A.ok(!!(s && s.created), 'us1: the snapshot is taken');
        A.eq([!!s && (await tree(aid, s.id)).includes(up + '/x.txt'), s && (s.links || []).map((l) => l.path)], [false, [lo]], 'us1: its tree drops ' + up + '/x.txt, read through nothing, and it records the junction ' + lo);
      });
      for (const [aid, body] of [['uu1', 'the person\'s edit, renamed, no capture took this\n'], ['uu2', 'same bytes\n']]) row(aid, async ({ refusedClean }) => {
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid), up = 'Éa.txt', lo = 'éa.txt';
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up), aid === 'uu1' ? 'T bytes\n' : 'same bytes\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + up });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        fs.rmSync(path.join(wt, up));
        put(path.join(wt, lo), body);
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apart, aid + ', a rewind where the person respelled ' + up + ' as ' + lo);
      });
      row('uboth', async ({ twoCalls, refusedClean }) => {
        const aid = 'uboth';
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid), [up, lo] = LATIN;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'a.txt'), 'first\n');
        const s0 = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0: one spelling' });
        fs.renameSync(path.join(wt, up), path.join(wt, lo));
        put(path.join(wt, lo, 'a.txt'), 'respelled\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const both = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the respelled folder captured' });
        const held = both ? await tree(aid, both.id) : [];
        A.eq([held.includes(up + '/a.txt'), held.includes(lo + '/a.txt')], [true, true], 'fixture (uboth): the capture of a respelled folder holds both spellings');
        fs.renameSync(path.join(wt, lo), path.join(wt, 'moved'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, both.id, 'uncaptured_check_failed', apart, 'uboth, a rewind to a tree that holds both spellings of one name');
        await twoCalls(store, aid, wt, s0.id, 'uboth, the file moved aside: a rewind to the tree that holds one spelling');
      });
      row('uok', async ({ twoCalls }) => {
        const aid = 'uok', wt = path.join(ROOT, aid), latin = LATIN[0], cyr = CYRILLIC[1], acc = 'Éa.txt';
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, latin, 'x.txt'), 'T x\n');
        put(path.join(wt, cyr, 'y.txt'), 'T y\n');
        put(path.join(wt, acc), 'T a\n');
        put(path.join(wt, 'pkg_1.0~1_amd64.deb'), 'T deb\n');
        put(path.join(wt, 'notes.txt~1'), 'T notes\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, latin, 'x.txt'), 'S x\n');
        fs.rmSync(path.join(wt, cyr), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, latin, 'new.txt'), 'new, no capture took this\n');
        put(path.join(wt, 'sub', 'über.txt'), 'new, no capture took this\n');
        put(path.join(wt, acc), 'the person\'s edit\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid } = await twoCalls(store, aid, wt, t.id, 'uok, names outside A-Z spelled alike everywhere');
        A.eq([mid[latin + '/x.txt'], mid[cyr + '/y.txt'], mid[acc]], ['T x\n', 'T y\n', 'T a\n'], 'uok: the rewind wrote T\'s files');
      });
      const cappedStore = (cut) => makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
        runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
      row('ucap1', async ({ cut, refusedClean }) => {
        const aid = 'ucap1';
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid), st = cappedStore(cut);
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 30; i++) put(path.join(wt, CYRILLIC[0], flatName(i)), 'x' + i + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 30 long names below ' + CYRILLIC[0] });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not list the names/, 'ucap1, a rewind whose listing of names outside A-Z passes the capped runner\'s limit');
        A.ok(cut.includes('ls-files'), 'ucap1: that listing passed the limit (' + JSON.stringify(cut) + ')');
      });
      row('ucap2', async ({ cut, refusedClean }) => {
        const aid = 'ucap2';
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid), out = outsideOf(aid), st = cappedStore(cut), [up, lo] = LATIN;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'x.txt'), 'T x\n');
        for (let i = 0; i < 30; i++) put(path.join(wt, CYRILLIC[0], flatName(i)), 'x' + i + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + up + '/x.txt and 30 long names' });
        fs.rmSync(path.join(wt, up), { recursive: true });
        link(out, path.join(wt, lo));
        put(path.join(wt, 'app.js'), 'v1\n');
        const seen = listing(out), s = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the listing is cut off' });
        const health = st.health(aid);
        A.eq(s, null, 'ucap2: a capture that cannot list what the index tracks below the junction is skipped (' + JSON.stringify(s) + ')');
        A.ok(/could not be listed/.test((health && health.lastFailure && health.lastFailure.reason) || ''), 'ucap2: and health says why (' + JSON.stringify(health && health.lastFailure) + ')');
        await refusedClean(st, aid, wt, t.id, 'link_check_failed', /could not be listed to check them for links/, 'ucap2, a rewind that cannot list what lies below a junction spelled outside A-Z');
        A.ok(cut.includes('ls-files'), 'ucap2: that listing passed the limit (' + JSON.stringify(cut) + ')');
        A.eq(listing(out), seen, 'ucap2: every path and byte outside the work tree is untouched');
      });
      row('ucap3', async ({ cut, refusedClean }) => {
        const aid = 'ucap3';
        if (!isWin) { console.log('[skip] ' + aid + ': no short names here'); return; }
        const wt = path.join(ROOT, aid), out = outsideOf(aid), st = cappedStore(cut);
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 60; i++) put(path.join(wt, 'with_a_long_descriptive_folder_name', 'n' + i + '~1'), 'x' + i + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 60 names of a short name\'s shape' });
        link(out, path.join(wt, 'lnk'));
        put(path.join(wt, 'app.js'), 'v1\n');
        const seen = listing(out), s = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the listing is cut off' });
        const health = st.health(aid);
        A.eq(s, null, 'ucap3: a capture that cannot list what the index tracks by a short name\'s shape, with a link to reach, is skipped (' + JSON.stringify(s) + ')');
        A.ok(/could not be listed/.test((health && health.lastFailure && health.lastFailure.reason) || ''), 'ucap3: and health says why (' + JSON.stringify(health && health.lastFailure) + ')');
        await refusedClean(st, aid, wt, t.id, 'pre_restore_failed', /could not be listed/, 'ucap3, a rewind whose capture cannot list them');
        A.ok(cut.includes('ls-files'), 'ucap3: that listing passed the limit (' + JSON.stringify(cut) + ')');
        A.eq(listing(out), seen, 'ucap3: every path and byte outside the work tree is untouched');
      });
      row('ucap0', async ({ cut, twoCalls }) => {
        const aid = 'ucap0';
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid), out = outsideOf(aid), st = cappedStore(cut), [up] = LATIN;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'x.txt'), 'T x\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        link(out, path.join(wt, CYRILLIC[1]));
        put(path.join(wt, up, 'x.txt'), 'S x\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a junction spelled outside A-Z, nothing tracked below it' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        const { mid } = await twoCalls(st, aid, wt, t.id, 'ucap0, the same names under the limit');
        A.eq([mid[up + '/x.txt'], mid[CYRILLIC[1]], listing(out)], ['T x\n', '<link>', seen], 'ucap0: the rewind wrote T\'s file, the junction stayed, and what it points at is untouched');
      });
    }
    {
      // WINDOWS SHORT NAMES (the security BLOCKER). NTFS gives a long name a second one, and a path spelled that way reaches the
      // long-named entry, while the walk's listings and Git's fold know the long name alone. snw: T holds LINKED~1/x.txt, a
      // junction `linked folder name` stands now: both calls ok:true, the outside x.txt gone. snf: T holds LONGNA~1.TXT, the
      // person's ignored `long name of mine.txt` was written over. snr: the undo row holds a literal LONGNA~1.TXT and T the long
      // name, which takes that short name once the reset has deleted the literal one: the rewind answered git_failed ("could not be
      // removed"), and a check of the undo's path against the file system would refuse that undo on every try. A rewind to or
      // from a tree that records a name of that shape is refused on Windows (the store's namesReadApart), whatever stands there,
      // so neither way writes through one: snw, snf, snr, and snc, a literal folder of that name, which would have
      // round-tripped. snd, sns1: what the index still tracks through such a name leaves the capture, as below a link: the
      // rewind that writes nothing there goes ahead both ways, and a plain snapshot stores no outside byte. Elsewhere such a
      // name is a name like any other
      const shape = /is spelled like a Windows short name/;
      // where the volume makes no short names the rows still hold, their refusals going by the shape, and only say so
      const noShortName = (aid, p) => { if (isWin && !fs.existsSync(p)) console.log('[note] ' + aid + ': this volume gives no short name here, so nothing is reached through one'); };
      row('snw', async ({ twoCalls, refusedClean }) => {
        const aid = 'snw', wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'LINKED~1', 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: LINKED~1/x.txt' });
        fs.rmSync(path.join(wt, 'LINKED~1'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the folder gone' });
        link(out, path.join(wt, 'linked folder name'));
        noShortName(aid, path.join(wt, 'LINKED~1'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        if (isWin) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', shape, 'snw, a rewind that would write LINKED~1/x.txt, a junction holding that short name');
        else await twoCalls(store, aid, wt, t.id, 'snw, a name like any other here');
        A.eq(listing(out), seen, 'snw: every path and byte outside the work tree is untouched');
      });
      row('snf', async ({ twoCalls, refusedClean }) => {
        const aid = 'snf', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitignore'), '*mine.txt\n');
        put(path.join(wt, 'LONGNA~1.TXT'), 'T short\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: LONGNA~1.TXT' });
        fs.rmSync(path.join(wt, 'LONGNA~1.TXT'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the file gone' });
        put(path.join(wt, 'long name of mine.txt'), 'the person\'s, ignored, in no restore point\n');
        noShortName(aid, path.join(wt, 'LONGNA~1.TXT'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (isWin) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', shape, 'snf, a rewind that would write LONGNA~1.TXT over the ignored long name holding it');
        else await twoCalls(store, aid, wt, t.id, 'snf, a name like any other here');
      });
      row('snr', async ({ twoCalls, refusedClean }) => {
        const aid = 'snr', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'long name of mine.txt'), 'T long\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the long name' });
        fs.rmSync(path.join(wt, 'long name of mine.txt'));
        put(path.join(wt, 'LONGNA~1.TXT'), 'S literal\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the literal name' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (isWin) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', shape, 'snr, a rewind whose undo row holds the literal LONGNA~1.TXT');
        else await twoCalls(store, aid, wt, t.id, 'snr, a name like any other here');
      });
      row('snc', async ({ twoCalls, refusedClean }) => {
        const aid = 'snc', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'LINKED~1', 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a literal LINKED~1' });
        put(path.join(wt, 'LINKED~1', 'x.txt'), 'S x\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (isWin) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', shape, 'snc, a rewind between trees that record a literal LINKED~1');
        else await twoCalls(store, aid, wt, t.id, 'snc, a name like any other here');
      });
      for (const aid of ['snd', 'sns1']) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing there' });
        put(path.join(wt, 'LINKED~1', 'x.txt'), 'S x\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: LINKED~1/x.txt tracked' });
        fs.rmSync(path.join(wt, 'LINKED~1'), { recursive: true });
        link(out, path.join(wt, 'linked folder name'));
        noShortName(aid, path.join(wt, 'LINKED~1'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        if (aid === 'sns1') {
          const s = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: a junction holding that short name' });
          A.eq([!!(s && s.created), !!s && (await tree(aid, s.id)).includes('LINKED~1/x.txt')], [true, false], 'sns1: the snapshot is taken, and its tree holds no path through the short name');
        } else {
          const { r } = await twoCalls(store, aid, wt, t.id, 'snd, a rewind that writes nothing through the short name the index tracks');
          A.eq(!!(r && r.preRestoreId) && (await tree(aid, r.preRestoreId)).includes('LINKED~1/x.txt'), false, 'snd: its undo row holds no path through the short name');
        }
        A.eq(listing(out), seen, aid + ': every path and byte outside the work tree is untouched');
      });
    }
    {
      // THE BYTES (the security BLOCKER). The store pinned core.autocrlf and core.safecrlf only, so a .gitattributes in the work
      // tree still converted: at1 at3 `* text=auto`, at4 at5 a text rule with an eol, at6 ident, at7 a working-tree-encoding:
      // both calls ok:true, the rewound file not T's bytes, the undo row's blob not the person's. The shadow repo's own
      // info/attributes, Git's highest precedence, turns every conversion off now: the undo row's blob is the person's bytes and
      // the rewound file T's. atold: a shadow repo an older store captured under such a rule: its index holds the converted
      // blob for a file whose stat it trusts, so the first capture since asks Git to read every tracked file again. atri: the
      // size ceiling's re-init, whose capture has a git-dir of its own
      const utf16 = (s) => Buffer.from(s, 'utf16le').toString('latin1');
      const blobOf = async (aid, id, name) => Buffer.from(await gitRun(['--git-dir', gitDirOf(aid), 'cat-file', 'blob', String(id).split(':').pop() + ':' + name])).toString('latin1');
      for (const [aid, attrs, name, v0, v1, v2] of [
        ['at1', '* text=auto\n', 'run.sh', 'one\ntwo\n', 'one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n'],
        ['at3', '* text=auto\n', 'app.js', 'one\ntwo\r\n', 'one\ntwo\r\nthree\n', 'one\ntwo\r\nthree\nfour\r\n'],
        ['at4', '*.js text eol=lf\n', 'app.js', 'one\r\ntwo\r\n', 'one\r\ntwo\r\nthree\r\n', 'one\r\ntwo\r\nthree\r\nfour\r\n'],
        ['at5', '*.js text eol=crlf\n', 'app.js', 'one\ntwo\n', 'one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n'],
        ['at6', '*.js ident\n', 'app.js', '$Id$ v0\n', '$Id$ v1\n', '$Id$ v2\n'],
        ['at7', '*.txt working-tree-encoding=UTF-16LE\n', 'w.txt', utf16('v0\n'), utf16('v1\n'), utf16('v2\n')]
      ]) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid), write = (body) => put(path.join(wt, name), Buffer.from(body, 'latin1'));
        put(path.join(wt, '.gitattributes'), attrs);
        write(v0);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        write(v1);
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        write(v2);
        const { r, mid } = await twoCalls(store, aid, wt, t.id, aid + ', a rewind under ' + attrs.trim());
        A.eq([mid[name], r && r.preRestoreId ? await blobOf(aid, r.preRestoreId, name) : null], [v0, v2], aid + ': the rewound file is T\'s bytes, and the undo row\'s blob the person\'s');
      });
      row('atold', async ({ twoCalls }) => {
        const aid = 'atold', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n', file = path.join(wt, 'app.js');
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(file, 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        put(file, mixed);
        const long = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(file, long, long);                      // older than the index the capture below writes: its stat is trusted
        const shadow = ['--git-dir', gitDirOf(aid), '--work-tree', wt].concat(ident);
        await gitRun(shadow.concat(['add', '-A']), { cwd: wt });
        await gitRun(shadow.concat(['commit', '-q', '-m', 'as an older store captured it']), { cwd: wt });
        A.eq(await blobOf(aid, 'HEAD', 'app.js'), 'one\ntwo\n', 'fixture (atold): the older capture\'s blob is the converted one');
        const { r } = await twoCalls(store, aid, wt, t.id, 'atold, a rewind in a shadow repo an older store captured under `* text=auto`');
        A.eq(r && r.preRestoreId ? await blobOf(aid, r.preRestoreId, 'app.js') : null, mixed, 'atold: the undo row\'s blob is the person\'s bytes');
      });
      row('atri', async () => {
        const aid = 'atri', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n';
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, maxRepoBytes: 1 });
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(path.join(wt, 'app.js'), mixed);
        const s = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: past the size ceiling at once' });
        A.eq([!!(s && s.maintenance && s.maintenance.reinit), await blobOf(aid, 'HEAD', 'app.js')], [true, mixed], 'atri: the size ceiling\'s re-init stores the bytes as they are too');
      });
    }
    {
      // `ignore = all` IN .gitmodules (the security BLOCKER). Plumbing diff-index and diff-tree skip a gitlink added or removed at a
      // path a .gitmodules marks so, a work-tree file: the write and removal lists never held it, nor did any check built on them.
      // m1: the person's ignored FILE v deleted where T records a gitlink v, ok:true on both calls. m3: an uncaptured FILE v: the
      // rewind went ahead and its undo was refused on every try (uncaptured_in_path). m4: a vendored clone (its .git deleted): the
      // rewind dropped the gitlink, and the undo's capture and reset deleted its files. Each is refused now as it is without
      // the setting (gf1 gf2; checkpoint-undo y5). mc mc2, the controls, both calls go ahead: nothing at v, and a clone the
      // rewind drops the gitlink of and its undo records again, its edit and its .git as they were
      const gitmodules = '[submodule "v"]\n\tpath = v\n\turl = ./nowhere\n\tignore = all\n';
      for (const [aid, how] of [['m1', 'ignored'], ['m3', 'uncaptured'], ['mc', 'none']]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitmodules'), gitmodules);
        await clone(path.join(wt, 'v'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at v' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tv$/m.test(await treeRecs(aid, t.id)), 'fixture (' + aid + '): T records v as a gitlink');
        fs.rmSync(path.join(wt, 'v'), { recursive: true, force: true });
        if (how === 'ignored') put(path.join(wt, '.gitignore'), 'v\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the clone gone' });
        if (how !== 'none') put(path.join(wt, 'v'), 'the person\'s FILE v, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (how === 'none') await twoCalls(store, aid, wt, t.id, 'mc, a rewind that records a gitlink where nothing stands, under ignore = all');
        else if (how === 'ignored') await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"v" as it is now is in no restore point \(Git ignores it\)/, 'm1, a rewind that would record a gitlink over an ignored FILE, under ignore = all');
        else await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"v" is a file now, and the restore point records an embedded Git repository \(a gitlink\) at that path/, 'm3, a rewind that would record a gitlink over an uncaptured FILE, under ignore = all');
      });
      row('mc2', async ({ twoCalls }) => {
        const aid = 'mc2', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitmodules'), gitmodules);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing at v' });
        await clone(path.join(wt, 'v'), { 'm.txt': 'module\n' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a clone at v' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tv$/m.test(await treeRecs(aid, s1.id)), 'fixture (mc2): S1 records v as a gitlink');
        put(path.join(wt, 'v', 'm.txt'), 'module, an uncommitted edit\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { r } = await twoCalls(store, aid, wt, t.id, 'mc2, a rewind that drops the gitlink of a clone, under ignore = all');
        A.eq(!!(r && r.preRestoreId) && /^160000 commit [0-9a-f]+\tv$/m.test(await treeRecs(aid, r.preRestoreId)), true, 'mc2: its undo row records the gitlink');
      });
      row('m4', async ({ refusedClean }) => {
        const aid = 'm4', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitmodules'), gitmodules);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing at v' });
        await clone(path.join(wt, 'v'), { 'm.txt': 'module\n', 'n.txt': 'n\n' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a clone at v' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tv$/m.test(await treeRecs(aid, s1.id)), 'fixture (m4): S1 records v as a gitlink');
        fs.rmSync(path.join(wt, 'v', '.git'), { recursive: true, force: true });
        put(path.join(wt, 'v', 'new.txt'), 'new in the vendored folder, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"v" is recorded as an embedded Git repository \(a gitlink\) but holds no repository/, 'm4, a rewind that would drop the gitlink of a vendored clone, under ignore = all');
      });
    }
    {
      // THE PERSON'S OWN GIT CONFIG (the security BLOCKER, and what else the same way in). Global settings reach the shadow repo's
      // calls, each read here through a store whose runner sets GIT_CONFIG_GLOBAL for its own Git alone. g2: submodule.recurse
      // and submodule.active: the rewind's reset ran in the person's clone: its uncommitted edit gone, its .git moved into the
      // shadow repo (a later size re-init deletes it). gis: core.ignoreStat: no capture saw the edit, and the reset wrote T over
      // it, ok:true on both calls. gfm: a core.fsmonitor hook answering "nothing changed": no capture saw it either, and the
      // rewind changed nothing, ok:true. ghk: core.hooksPath: the person's hooks ran on the shadow repo's index and refs, one
      // writing in the work tree (the undo answered git_failed). gat: core.attributesFile: at1 with nothing in the work tree.
      // gfl: a clean filter the person configured, named by a .gitattributes: the blob was the filter's output.
      // All are pinned now, as core.autocrlf is
      const withConfig = (aid, text) => {
        const file = path.join(BASE, aid + '-gitconfig');
        fs.writeFileSync(file, text);
        const spawnIt = (f, argv, options) => launchSpawn(f, argv, Object.assign({}, options, { env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: file }) }));
        const runner = makeCheckpointGitRunner({ spawn: spawnIt, clock: { now: () => Date.now() }, timeoutMs: 60000 });
        return makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit: runner, clock, keep: 50 });
      };
      const inConfig = (p) => '"' + p.split(path.sep).join('/') + '"';
      const script = (file, body) => { fs.writeFileSync(file, '#!/bin/sh\n' + body + '\nexit 0\n'); fs.chmodSync(file, 0o755); };
      row('g2', async ({ twoCalls }) => {
        const aid = 'g2', wt = path.join(ROOT, aid), v = path.join(wt, 'v');
        const st = withConfig(aid, '[submodule]\n\trecurse = true\n\tactive = .\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitmodules'), '[submodule "v"]\n\tpath = v\n\turl = ./nowhere\n');
        await clone(v, { 'm.txt': 'module A\n' });
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at v' });
        put(path.join(v, 'm.txt'), 'module B\n');
        await gitRun(ident.concat(['add', '-A']), { cwd: v });
        await gitRun(ident.concat(['commit', '-q', '-m', 'b']), { cwd: v });
        put(path.join(v, 'm.txt'), 'module B, an uncommitted edit\n');
        put(path.join(v, 'new.txt'), 'untracked in the clone\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the clone moved' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await twoCalls(st, aid, wt, t.id, 'g2, a rewind across a gitlink under submodule.recurse and submodule.active');
        A.eq([fs.lstatSync(path.join(v, '.git')).isDirectory(), fs.readFileSync(path.join(v, 'm.txt'), 'utf8')], [true, 'module B, an uncommitted edit\n'], 'g2: the clone keeps its .git and its uncommitted edit');
      });
      row('gis', async ({ twoCalls }) => {
        const aid = 'gis', wt = path.join(ROOT, aid), st = withConfig(aid, '[core]\n\tignoreStat = true\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid } = await twoCalls(st, aid, wt, t.id, 'gis, a rewind under core.ignoreStat');
        A.eq(mid['app.js'], 'v0\n', 'gis: the rewind wrote T\'s file');
      });
      row('gfm', async ({ twoCalls }) => {
        const aid = 'gfm', wt = path.join(ROOT, aid), hook = path.join(BASE, aid + '-fsmonitor');
        script(hook, 'printf "token\\0"');
        const st = withConfig(aid, '[core]\n\tfsmonitor = ' + inConfig(hook) + '\n\tfsmonitorHookVersion = 2\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        A.ok(!!(s1 && s1.created), 'gfm: the capture sees the edit (' + JSON.stringify(s1) + ')');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid } = await twoCalls(st, aid, wt, t.id, 'gfm, a rewind under a core.fsmonitor hook that answers nothing changed');
        A.eq(mid['app.js'], 'v0\n', 'gfm: the rewind wrote T\'s file');
      });
      row('ghk', async ({ twoCalls }) => {
        const aid = 'ghk', wt = path.join(ROOT, aid), hooks = path.join(BASE, aid + '-hooks'), stamp = path.join(BASE, aid + '-stamp');
        fs.mkdirSync(hooks, { recursive: true });
        for (const name of ['pre-commit', 'post-commit', 'post-index-change', 'reference-transaction']) script(path.join(hooks, name), 'echo ran >> ' + inConfig(stamp) + '\necho hooked >> hook-wrote-this.txt');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await twoCalls(withConfig(aid, '[core]\n\thooksPath = ' + inConfig(hooks) + '\n'), aid, wt, t.id, 'ghk, a rewind under the person\'s core.hooksPath');
        A.eq(fs.existsSync(stamp), false, 'ghk: no hook of the person\'s ran on the shadow repo');
      });
      row('gfl', async ({ twoCalls }) => {
        const aid = 'gfl', wt = path.join(ROOT, aid), st = withConfig(aid, '[filter "up"]\n\tclean = tr a-z A-Z\n\tsmudge = tr A-Z a-z\n');
        put(path.join(wt, '.gitattributes'), '*.txt filter=up\n');
        put(path.join(wt, 'a.txt'), 'Mixed v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'a.txt'), 'Mixed v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'a.txt'), 'Mixed v2\n');
        const { mid } = await twoCalls(st, aid, wt, t.id, 'gfl, a rewind under a filter the person configured');
        A.eq(mid['a.txt'], 'Mixed v0\n', 'gfl: the rewound file is T\'s bytes');
      });
      row('gat', async ({ twoCalls }) => {
        const aid = 'gat', wt = path.join(ROOT, aid), attrs = path.join(BASE, aid + '-attributes');
        fs.writeFileSync(attrs, '* text=auto\n');
        const st = withConfig(aid, '[core]\n\tattributesFile = ' + inConfig(attrs) + '\n');
        put(path.join(wt, 'run.sh'), 'one\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'run.sh'), 'two\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'run.sh'), 'three\n');
        const { mid } = await twoCalls(st, aid, wt, t.id, 'gat, a rewind under the person\'s core.attributesFile');
        A.eq(mid['run.sh'], 'one\n', 'gat: the rewound file is T\'s bytes');
      });
    }
    {
      // A GIT LAUNCH THAT FAILS (the security BLOCKER): spawn's 'error' through the real runner, for one verb only. The runner
      // answered { code: 1 }, which check-ignore reads as "none of these is ignored" and grep as "no line at all". lf1, lf2: the
      // person's ignored FILE logs deleted, and the newer ignored .env written over, ok:true on both calls. lf3: THE RULES A
      // REWIND CHANGES read no rule in the staged tree's .gitignore and did not refuse the `*.log` it refuses when every launch
      // starts (the control, first), and the undo was then refused on every try. The runner answers -1 now, as for a timeout.
      // atfail: atold's first capture, its read-tree failing to start: refused, and the next try reads every file again
      const failingLaunch = (aid) => {
        const state = { verb: '', when: null, seen: 0 };
        const spawnIt = (file, argv, options) => {
          if (state.verb && argv.includes(state.verb) && (!state.when || state.when(argv))) { state.seen++; return launchSpawn('git-that-does-not-exist-' + aid, argv, options); }
          return launchSpawn(file, argv, options);
        };
        const runner = makeCheckpointGitRunner({ spawn: spawnIt, clock: { now: () => Date.now() }, timeoutMs: 60000 });
        return { state: state, st: makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit: runner, clock, keep: 50 }) };
      };
      for (const [aid, name, tracked] of [['lf1', 'logs', 'logs/a.txt'], ['lf2', '.env', '.env']]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid), { state, st } = failingLaunch(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, tracked), 'a, in T\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + tracked });
        fs.rmSync(path.join(wt, name), { recursive: true });
        put(path.join(wt, '.gitignore'), name + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule, the path gone' });
        put(path.join(wt, name), 'the person\'s ignored FILE, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        state.verb = 'check-ignore';
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not say which files it ignores/, aid + ', a rewind whose check-ignore could not start');
        A.ok(state.seen > 0, 'fixture (' + aid + '): that launch failed');
      });
      row('atfail', async ({ twoCalls, refusedClean }) => {
        const aid = 'atfail', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n', file = path.join(wt, 'app.js'), { state, st } = failingLaunch(aid);
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(file, 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        put(file, mixed);
        const long = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(file, long, long);
        const shadow = ['--git-dir', gitDirOf(aid), '--work-tree', wt].concat(ident);
        await gitRun(shadow.concat(['add', '-A']), { cwd: wt });
        await gitRun(shadow.concat(['commit', '-q', '-m', 'as an older store captured it']), { cwd: wt });
        state.verb = 'read-tree';
        await refusedClean(st, aid, wt, t.id, 'pre_restore_failed', /could not read the last restore point again/, 'atfail, a rewind whose first capture could not read the index again');
        A.ok(state.seen > 0, 'fixture (atfail): that launch failed');
        state.verb = '';
        await twoCalls(st, aid, wt, t.id, 'atfail, the next try');
      });
      row('lf3', async ({ refusedClean }) => {
        const aid = 'lf3', wt = path.join(ROOT, aid), { state, st } = failingLaunch(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no .gitignore' });
        put(path.join(wt, '.gitignore'), '*.log\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a glob rule' });
        put(path.join(wt, 'x.log'), 'the person\'s ignored log, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /rewinding changes the rule "\*\.log"/, 'lf3\'s control, every launch starting');
        state.verb = 'grep';
        state.when = (argv) => !argv.includes(String(t.id));   // the staged tree's read, not the target's
        await refusedClean(st, aid, wt, t.id, 'link_check_failed', /the \.gitignore files its undo would bring back could not be read/, 'lf3, a rewind whose read of the staged tree\'s .gitignore could not start');
        A.ok(state.seen > 0, 'fixture (lf3): that launch failed');
      });
    }
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
