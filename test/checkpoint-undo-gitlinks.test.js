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
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was); each refusal row has a control one step short of it that goes ahead both ways (gf3, h4c, h4ps, h4gc). The
   depth rows use a store walking 5 levels against a target recorded with the default depth, as an older store or a
   bigger budget records one (W depth, test/checkpoint-undo.test.js); N2 uses the real runner capped at 1500 bytes and a
   70-entry walk budget, as N1. Every row runs against a real temp work tree and real git. Fixtures: clones (their own
   .git, made by this file's git, never the shadow repo), a linked worktree of one, and a `.git` junction (Windows) or
   directory symlink (POSIX) to such a clone's .git, all inside this test's own os.tmpdir() folder; the link is removed
   with `cmd /c rmdir` (Windows) / unlink before the folder is deleted. */
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
function tree(aid, id) {
  return execFileSync('git', ['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', String(id).split(':').pop()], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
// the same restore point's records ("<mode> <type> <sha>\t<path>" per line): a fixture's premise on what it records
function treeRecs(aid, id) {
  return execFileSync('git', ['--git-dir', gitDirOf(aid), 'ls-tree', '-r', String(id).split(':').pop()], { encoding: 'utf8' });
}
// Git on the shadow repo of `aid` with its work tree -> { code, out } (a fixture's premise, never the store's own call)
function gitIn(aid, args) {
  try { return { code: 0, out: execFileSync('git', ['--git-dir', gitDirOf(aid), '--work-tree', path.join(ROOT, aid)].concat(args), { cwd: path.join(ROOT, aid), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || '') }; }
}
// a clone with one commit in `dir` (its own .git, never the shadow repo's), from `files`
function clone(dir, files) {
  for (const [rel, body] of Object.entries(files)) put(path.join(dir, rel), body);
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false'];
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', id.concat(['add', '-A']), { cwd: dir, stdio: 'ignore' });
  execFileSync('git', id.concat(['commit', '-q', '-m', 'c']), { cwd: dir, stdio: 'ignore' });
}
const flatName = (i) => 'sample_' + String(i).padStart(4, '0') + '_with_a_long_descriptive_name.bin';

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  // the real runner, its output limit 1500 bytes; `cut` names the Git verbs it cut off since it was last emptied
  const cut = [];
  const cappedRunner = makeCheckpointGitRunner({ spawn, maxBytes: 1500, clock: { now: () => Date.now() } });
  const verbOf = (args) => args.find((a) => /^(diff-index|diff-tree|ls-files|ls-tree|grep|cat-file|check-ignore)$/.test(a)) || '?';

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

  try {
    const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false'];
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
      // gitlink keeps the index's V). gf3, the control: nothing at v now, both calls go ahead
      for (const [aid, at, gl, how] of [['gf1', 'v', 'v/sub', 'captured'], ['gf1u', 'v', 'v/sub', 'uncaptured'], ['gf1d', 'lib/v', 'lib/v/sub', 'captured'],
        ['gf2', 'v', 'v', 'captured'], ['gf2c', 'v', 'V', 'uncaptured'], ['gf3', 'v', 'v', 'none']]) {
        if (aid === 'gf2c' && !foldsCase) { console.log('[skip] gf2c: this file system does not fold case'); continue; }
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        if (gl.length > at.length) put(path.join(wt, at, 'a.txt'), 'a in T\n');
        clone(path.join(wt, gl), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at ' + gl });
        A.ok(!!t && new RegExp('^160000 commit [0-9a-f]+\\t' + esc(gl) + '$', 'm').test(treeRecs(aid, t.id)), 'fixture (' + aid + '): T records ' + gl + ' as a gitlink');
        fs.rmSync(path.join(wt, gl.length > at.length ? at : gl), { recursive: true, force: true });
        if (how === 'captured') put(path.join(wt, at), at + ' is a FILE now\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        A.eq([!!(s1 && s1.created), !!s1 && tree(aid, s1.id).includes(at)], [true, how === 'captured'], 'fixture (' + aid + '): S1 ' + (how === 'captured' ? 'holds' : 'lacks') + ' ' + at);
        if (how === 'uncaptured') put(path.join(wt, at), at + ' is a FILE no capture took\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (how === 'none') { await twoCalls(store, aid, wt, t.id, 'gf3, a rewind that records a gitlink where nothing stands'); continue; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', new RegExp('^"' + esc(at) + '" is a file now, and the restore point records an embedded Git repository \\(a gitlink\\) '
          + (gl.length > at.length ? 'at "' + esc(gl) + '", inside the folder it holds there' : 'at that path') + ': .* which its undo could not turn back into the file'),
        aid + ', a rewind that would record the gitlink ' + gl + ' where ' + (how === 'uncaptured' ? 'an uncaptured' : 'the') + ' FILE ' + at + ' stands');
      }
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
      {
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
        A.ok(!!(t && s1 && s1.created) && tree(aid, t.id).includes('gen/a/b/c/d/e/f/x.txt') && tree(aid, s1.id).includes('gen'), 'fixture (h4a): T tracks gen/, its folders six deep, below its rule; S1 holds the FILE gen');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, 'h4a, a rewind that makes a pruned gen/ over the FILE gen, its folders six deep (depth 5)');
      }
      {
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
        A.ok(!!(t && s2 && s2.created) && tree(aid, s2.id).includes('gen') && tree(aid, s2.id).includes('.gitignore'), 'fixture (h4b): the undo row\'s .gitignore lists gen, and it holds the FILE gen');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, 'h4b, the same with the rule in the undo row\'s own .gitignore (depth 5)');
      }
      for (const [aid, dirs, refused] of [['h4cd', ['p', 'q', 'r', 's', 't', 'w'], true], ['h4c', ['p', 'q', 'r', 's', 't'], false]]) {
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
        A.ok(!!(t && s1 && s1.created) && tree(aid, s1.id).includes('a'), 'fixture (' + aid + '): S1 holds the FILE a');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that turns the FILE a into a/ holding a pruned node_modules, its folders ' + dirs.length + ' deep (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      }
      for (const [aid, dirs, refused] of [['h4p', ['a', 'b', 'c', 'd', 'e', 'f'], true], ['h4ps', ['a', 'b', 'c', 'd', 'e'], false]]) {
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
        A.ok(!!(t && s2 && s2.created) && tree(aid, s2.id).includes('node_modules/x') && tree(aid, s2.id).includes('.gitignore'), 'fixture (' + aid + '): the undo row holds the FILE node_modules/x below its rule');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that turns the FILE node_modules/x, in a pruned folder, into a folder, its folders ' + dirs.length + ' deep (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      }
      for (const [aid, at, keep, refused] of [['h4g', 'a/b/c/d/e/f', '', true], ['h4g2', 'a/b/c/d/e/f', 'a/b/c/d/e/keep.txt', true], ['h4gc', 'a/b/c/d/e', '', false]]) {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        if (keep) put(path.join(wt, keep), 'keep\n');
        clone(path.join(wt, at), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at ' + at });
        A.ok(!!t && new RegExp('^160000 commit [0-9a-f]+\\t' + esc(at) + '$', 'm').test(treeRecs(aid, t.id)), 'fixture (' + aid + '): T records ' + at + ' as a gitlink');
        fs.rmSync(path.join(wt, keep ? at : 'a'), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await st5.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no clone' });
        A.ok(!!(s1 && s1.created), 'fixture (' + aid + '): S1 recorded by the store walking 5 levels');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that records the gitlink ' + at + (keep ? ', its folder ' + at.split('/').slice(0, -1).join('/') + ' there' : '') + ' (depth 5)';
        if (refused) await refusedClean(st5, aid, wt, t.id, 'link_check_failed', tooDeep, label);
        else await twoCalls(st5, aid, wt, t.id, label);
      }
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
      for (const kind of ['junction', 'worktree']) {
        const aid = 'n2' + kind[0], wt = path.join(ROOT, aid), X = path.join(wt, 'X'), Z = path.join(wt, 'Z'), main = path.join(BASE, aid + '-main');
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 30; i++) put(path.join(X, 'x' + flatName(i).slice(0, 30)), 'x' + i + '\n');
        clone(main, { 'README': 'main\n' });
        if (kind === 'worktree') execFileSync('git', ident.concat(['worktree', 'add', '-q', '--detach', Z]), { cwd: main, stdio: 'ignore' });
        else { fs.mkdirSync(Z); link(path.join(main, '.git'), path.join(Z, '.git')); put(path.join(Z, 'README'), 'main\n'); }
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: X with 30 files, Z a gitlink' });
        A.ok(!!t && /^160000 [0-9a-f]+ 0\tZ$/m.test(gitIn(aid, ['ls-files', '-s', '--', 'Z']).out), 'fixture (' + aid + '): T records Z as a gitlink');
        for (let i = 0; i < 60; i++) put(path.join(Z, 'src', 'm' + i + '.js'), 'module ' + i + '\n');
        for (let i = 2; i < 30; i++) fs.unlinkSync(path.join(X, 'x' + flatName(i).slice(0, 30)));
        execFileSync('git', ['init', '-q'], { cwd: X, stdio: 'ignore' });
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
      }
    }
    {
      // this file runs 48-120 s with other gates running (slow.list says when), past test/slow.list's 40 s rule; listed
      // there, a gate gives it 600 s, not 120 s. Its rows were split from test/checkpoint-undo.test.js so that file keeps
      // that much room too. A step of the fast gate, beside it
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
