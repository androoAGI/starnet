/* node test/checkpoint-links.test.js — a checkpoint never reads, writes or deletes THROUGH a link (lane checkpoint-links,
   review rounds 1-6, 2026-10-30; sidecar/checkpoint-store.js, the header's LINKS and restore's WHAT A REWIND REMOVES).

   Git for Windows walks a junction as if it were a plain folder. Before this lane, on trunk d5024f5a:
     A  a junction in the workspace pointing at a folder outside it was captured: its files became 100644 blobs of the
        snapshot (jx/secret.txt), health stayed ok and no row said a link was there;
     B  a tracked folder swapped for a junction was re-read through it under the old tracked names;
     C' F  restore's `reset --hard` then DELETED the real files behind a junction (a folder, or a tracked file, swapped for
        one) and reported ok:true; with the target's files under a junction it WROTE through it;
     E  the npm-link rewind: node_modules/mylib a junction to a sibling ../mylib, rewound to a turn before the link:
        mylib/index.js and mylib/src/core.js deleted, restore ok:true.
   Every capture now goes through ONE boundary (prepareCapture: the walk that never follows, the exclusion, the dropped
   tracked descendants, the recorded links): a normal snapshot, restore's pre-restore capture and the size-ceiling re-init.
   Restore refuses, before anything is touched, a path it would write or delete through a link.

   Every row below runs against a REAL temp work tree and REAL git, but for section 10 and the last two blocks of row 19:
   source-text locks (the scope statements, the restore route's answers, the slow.list entry) beside one control of
   Node's own fs.rmSync (the SSH mirror wipe's loop, copied: it says what Node does, so it is green on trunk too).
   Fixtures: junctions (Windows) or directory symlinks
   (POSIX) made only inside this test's own os.tmpdir() folder, pointing only at sibling folders it made; removed with
   `cmd /c rmdir` (Windows) / unlink before the folder is deleted. A volume mount point needs no administrator rights
   (FSCTL_SET_REPARSE_POINT on an empty folder the person owns), but a live one is a plain folder to lstat, so a
   cleanup that missed it could delete through it into that volume; and Node's own junction call, given a
   \\?\Volume{GUID}\ target, writes it without the last backslash, which lstat answers with ELOOP (a GUID naming no
   volume), not the ENOENT the review's, made with that ioctl, gave. Section 8 therefore drives the classification
   through an injected fs that reports an entry exactly as libuv reports a volume mount point (a reparse point in the
   listing, a plain folder to lstat; a dangling one, nothing at all): the answers review minors got from real ones,
   live and dangling (Node 22.23).

   RESIDUAL (out of scope, the run-paths threat model; same note as the store header): a folder swapped for a link in
   the moment between the walk and Git's own read of it is still followed (TOCTOU, a hostile same-user actor). Tier 2,
   lane "checkpoint-manifest" (a checkpoint-owned manifest + a native Windows no-follow adapter, joined with the claims
   gap W2-link-junction-containment), closes it.
   Review round 2 (rows 11-15): P8, a target that holds a FILE where a folder with a link below it now is (reset empties
   that folder through the link before it writes the file; also inside an ignored folder or an embedded repository);
   restore's clean, which unlinked a link the target's .gitignore re-includes (P2) and removed a folder only the current
   .gitignore ignored, link and never-captured files with it (P1); an embedded repository holding a link, which made
   every later capture and rewind fail (check-ignore and add die on a path below a gitlink) and cost the walk its whole
   budget; link order that changed with I/O timing, so an unchanged tree never deduped; and a POSIX root reached through
   a link, which made every folder a mount point.
   Review round 3 (row 16): P8 one level INSIDE a folder the walk does not enter (the target holds a FILE at build/sub
   under an ignored build/, or at proj/sub inside an embedded clone; reset emptied the folder behind sub/jl and the
   rewind said ok); a `.git` that is itself a junction in a folder the walk enters (never a recorded link, as Git never
   reads it; reset emptied a relocated git-dir through it); a `.git` FILE Git does not read as a gitfile (no space,
   two spaces or a tab after "gitdir:", or a second line), which the walk took for an embedded repository and skipped
   while Git read the folder and a junction in it (introduced by round 2's embedded-repository walk); and restore's
   clean, which needed one pattern per ignored folder, so 700 __pycache__ folders with no link refused every rewind
   (introduced by round 2's keptInPlace; round 3 made it one pattern per .gitignore rule).
   Review round 4 (row 17): P8 through a link INSIDE a real `.git` folder, which neither the walk nor the check ever
   listed (entry.c remove_subtree has no case for `.git`): the target holds a FILE at proj, now a clone whose .git/hooks
   is a junction to a shared hooks folder, or at x, now a walked folder whose plain .git holds a .git/lfs junction; reset
   emptied both outside folders and the rewind said ok. And restore's clean, whose one pattern per .gitignore rule was
   still one per package .gitignore: a monorepo of 400 packages each listing dist/ and .turbo/ refused every rewind
   (introduced by round 2's keptInPlace, narrowed in round 3; round 4 made it one pattern per ignored folder name).
   Review round 5 (row 18): restore's clean deleted for good files no capture took: an ignored .env, a *.log, a folder a
   glob rule ignores, once reset had written a target .gitignore without the rule (trunk d5024f5a did the same). A
   rewind now runs no clean at all, so keptInPlace and its bound are gone (everything clean could still delete after
   the pre-restore capture was such a file). Also: the claim that a `.git` junction, or a link inside a plain `.git`
   folder, in a folder the target lacks is safe had no row; and a `.git` interior a check lists counted toward the
   person's own entry budget, so a refusal quoted a count they could not relate to (it now has a count of its own,
   and a refusal over it names that `.git`).
   Review round 6 (row 19, 18c): reset still replaced or deleted what no capture took wherever the target holds that path
   (trunk d5024f5a did the same, ok:true): the person's newer, ignored .env under the target's old one (E2), an ignored
   build/ folder and its key where the target holds a FILE `build` (E3), an ignored `logs` file where it holds logs/ (E4),
   a clone where it holds a FILE `vendor`, its .git and uncommitted work with it (E5), a clone's own edited file where it
   holds that file, and a plain `.git` folder (18c, which pinned that deletion as success). Each is now refused before
   anything is touched ('uncaptured_in_path', the path named). And with no clean left, a file reset could not unlink (held
   open by another program: Git warns, exits 0) made the rewind report ok:true; it is git_failed again, the file named
   (test/checkpoint-store.test.js row 4b).
   Review 6.2 (row 19, the w6 block): the check counted a folder as a repository only by the walk's looksLikeRepo,
   which is stricter than Git's own rule, so a LINKED WORKTREE (a commondir git-dir) and a folder whose `.git` is a link
   to a repository, both one gitlink to `add -A`, were plain folders to it: reset wrote the target's file over a
   worktree's uncommitted edit, deleted a worktree's folder for a target FILE, and overwrote an edit beside a `.git` link,
   ok:true each time (9b8c79a2 and trunk d5024f5a did the same). Every folder holding a `.git` of any kind that the shadow
   index tracks no path below now counts. And the rewind's two whole-change listings no longer depend on one call under
   the runner's output limit (test/checkpoint-store.test.js row 4c).
   Review minors (all rounds; rows 1, 4, 8b, 10, 11, 18, 19): an agent's FIRST snapshot recorded two rows for one commit
   (the git-log rebuild's lossy one first, the new row its own parent); a dangling mount point (libuv's lstat follows a
   reparse point it cannot read as a link, so ENOENT) was 'gone', neither left out nor refused (the lane's own
   classifier, round 1); row 4's "next capture" row says what it rests on; section 10's SSH lock reads environment.js
   alone; row 11's build/ and proj/ halves have a work tree each, so the embedded repository's capture failure before
   round 2 no longer hides the build/ deletion the label names; row 18a pins which way the undo goes; row 18's budget
   block pins the on-demand listing of a pruned folder past the person's own count (link_check_failed); a
   macOS `.GIT` (case folded, as Git reads it there) never counted as a `.git` (the w7 block emulates macOS on NTFS,
   which folds the same way); nor did one on Linux over a case-insensitive mount (WSL's /mnt/c, ext4 casefold,
   vfat/exFAT), where a clone, a linked worktree or a link spelled .GIT is one gitlink to Git too (w7d-w7f; it counts
   on every platform now: on a case-sensitive volume Git refuses to add any `.GIT` path, add exits 128); a `.GIT` folder
   or non-gitfile `.GIT` in a captured folder the target holds as a FILE is named only by the walk's gitFolders and
   gitFiles, which no row reached (w7b, w7c); and test/checkpoint-store.test.js row 4d pins the fail-closed answers of the round 6
   checks (uncaptured_check_failed; a listing failure after the reset is git_failed, the undo row recorded). And what
   reset will remove was listed only after it ran: a rewind past a flat folder whose own entry list passes the runner's
   output limit deleted it, answered git_failed, and every restore of its undo row was refused, as that rewind's own
   write list overflowed the same way (the folder then lived only in the shadow repo; introduced by round 6's two
   listings, narrowed to that folder by review 6.2's). It is now listed before the pre-restore commit, and that rewind
   is refused untouched (store row 4c).
   Final review 2 (row 20; store row 4c): a COMPLETED rewind whose returned preRestoreId the normal API then refused,
   three ways, each introduced by this lane: (1) by round 1's link check, (2) by round 6's uncaptured check, (3) by round
   5's rewind without a clean (trunk d5024f5a's clean deleted that node_modules for good, and its undo then ran).
   (1) The link check listed a folder the target's .gitignore prunes in one ls-files call: past the
   runner's output limit, the undo of a rewind that deleted 120 captured files there was refused (link_check_failed),
   and every capture was skipped while the index tracked such a folder. (2) The undo of a rewind that turned a captured
   FILE into the target's big folder listed that folder's gitlinks in one ls-files -s call (uncaptured_check_failed).
   (3) A rewind to a point before the .gitignore that pruned a never-captured node_modules left it in place, unpruned:
   its undo walked it, past the walk's budget refused (link_check_failed), within it captured it whole and deleted it.
   Every whole-folder listing now splits (listUnder, gitlinksAtOrBelow), and a rewind's walk and capture go by the
   target's own .gitignore too, leaving out a folder only that prunes; each row runs restoreDetailed(preRestoreId) and
   compares every path and byte.
   Undo closure (row 20, fr2-fr6; the r3 review and Codex A4-2D1-01/02): a completed rewind's preRestoreId was still
   refused, or its undo deleted what no capture took, four ways, each from final review 2's target rules. A folder only
   the target's .gitignore lists, where the target held a path, was walked and captured whole: (fr3, fr3b) the rewind
   never listed it, and its undo, pruning it by the rewound .gitignore, listed it whole, past the limit for a flat
   folder (link_check_failed); (fr4) the undo of a rewind that had kept a node_modules' untracked files out, its row
   tracking files there, walked it (past the budget refused) and took them and deleted them. Every such folder is kept
   out now, a file there the rewind writes over or deletes taken by name (fr2), and the undo's own listing below the
   pruned folders is taken on the staged tree before the pre-restore commit, so a rewind that would leave it to an
   impossible listing is refused untouched (fr3c). (fr5) Past 32 changed .gitignore files the target's rules were
   dropped and the undo walked node_modules: every one is read now (git grep), and a rewind Git cannot read them for is
   refused. (fr6) Whether the target held a path there was asked case by case, so a case-only spelling refused it.
   Undo review 1 (test/checkpoint-undo.test.js, its header names each shape): the undo's read of its row's .gitignore
   files passed the runner's limit in one grep call (G1) or skipped one Git takes for binary (G2, G3: -I); its listing
   below a folder it prunes split down through a flat folder above it (R2, Ra, P1, P2); a folder its row's rule names
   beside a double-star bracket negation, or in another case, was walked and emptied (N, K); and a folder of files no
   capture took was deleted where the target holds a FILE and the index still did (P3, P3b: `ls-files --directory`
   printed nothing for it). And a rewind to a point an older store recorded with more files than the walk allows
   completed, its undo's walk over budget (W). Every .gitignore is read as text, a batch past the limit in halves, a
   file by its bytes; what the undo will read, list and walk is taken before the rewind's commit (its write list, its
   row's .gitignore texts, below every link, pruned folder and embedded repository its walk will find, the folders the
   reset makes among them, and its walk's count and depth); a listing never reads a folder above what it lists; a
   negation matches what it can match, a rule in another case keeps its folder out; and such a folder is listed file by
   file, what only the target's rules ignore there taken by name.
   DEFERRED (each a follow-up, none loosens what a rewind keeps):
     - an ignored file the target does not ignore (.env, kept by a rewind) is taken off disk by that rewind's undo and
       held only in the undo's own undo row, beside the rewound files (row 18a; the store's restore comment says so),
       and so is a folder that only a rule the walk cannot read ignores (a glob such as `*.egg-info/`, a path such as
       `out/gen/`): the walk prunes by plain names only. A folder a plain name ignores stays, tracked files there or not
       (row 20 fr1 and fr4), in any case where the file system folds case (checkpoint-undo K) and beside any negation
       that cannot re-include it (N; one that can, the walk enters: N's control). What the undo takes so also joins its
       removal list, which no listing of the rewind holds. Keeping those in place needs the target's full ignore rules
       evaluated before the reset;
     - an untracked embedded repository with no commit yet still makes every capture fail (Git's add exits 128), as on
       trunk d5024f5a; health says so. Leaving it out of `add` needs a new excluded class at the capture boundary;
     - a flat folder whose own entry list (ls-tree, names only) passes the runner's output limit, about 150k-250k long
       names at 8 MB. STORED: every captured file of it is in the shadow repo, which alone proves nothing. API-RESTORABLE:
       a restore point holding it restores through restoreDetailed whenever that rewind need not list the folder whole
       (it writes or removes few of its files, and no .gitignore of either side prunes a folder above it). Otherwise
       REFUSED BEFORE ANYTHING IS TOUCHED, with no undo row: a rewind that brings back or removes so many of its files
       that their names alone pass the limit (uncaptured_check_failed), or must check them for links below a pruned
       folder (link_check_failed); store row 4c, the cf and cv blocks. A capture is skipped while the index tracks it
       below a pruned folder (health says so). What a completed rewind's undo will list is taken before the rewind's
       commit, on its staged tree: its write list (the rewind's removals), its row's changed .gitignore texts, and what
       the target and its row hold below every link, pruned folder and embedded repository its walk will find, the
       folders the reset makes that a plain rule prunes among them (row 20 fr3c; checkpoint-undo G1b), and the count and
       depth of its walk (checkpoint-undo W); its removals are the rewind's own writes; and no listing reads the entry
       list of a folder above what it lists (checkpoint-undo R2, Ra, P1, P2). So no listing an undo takes needs a folder
       entry list its rewind did not take, or the rewind is refused untouched, but for what the undo's capture takes that
       the rewind left (the first bullet). Such a rewind cannot run (splitting by name prefix is the follow-up);
     - wall time still bounds every restore, an undo too: the walk's 10 s deadline and the runner's 15 s per Git call
       depend on the machine, so an undo's add of a big folder no plain rule of its row excludes (a glob-ignored build
       folder the rewind un-ignored) can be refused (pre_restore_failed, untouched) on a slow machine; the person then
       moves that folder aside and undoes again;
     - restore's checks cost Git calls: about 10 per 256 files that stand at a path the rewind writes (the uncaptured
       check, no deadline of its own), and replacedFolders asks every pruned folder and its ancestors even with no
       link; bounded, never a hang;
     - shell.bg.write now shares the per-turn precise checkpoint key, as terminal.write did on trunk: a second write in
       the same turn after an unchanged first one takes no new snapshot (the key lives in index.js's closure);
     - the links a capture left out reach no screen: the restore route's 200 body, checkpoint.created and the RESTORE
       lane do not show them, and frontend/app/windows/rewind.js still says a rewind removes anything created since
       (it keeps ignored files and links); a frontend follow-up.
   PRE-EXISTING (the lane did not worsen them; the rows here pin the fix): A, B, C', E, F above; P8 (trunk d5024f5a
   emptied the same folder, having also captured it), P8 inside an ignored folder or an embedded repository, through a
   `.git` junction and through a link inside a real `.git` folder (trunk d5024f5a emptied the same folders, rows 11, 16
   and 17), the P1 shape of the clean (trunk removed the same folder) and its .env shape (row 18); and the pre-admission
   snapshots test/checkpoint-admission.test.js covers; the shapes of the store's NOTHING NO CAPTURE TOOK of round 6 (row
   19: trunk replaced or deleted the same files), the linked-worktree and `.git`-link shapes of review 6.2 among them;
   and an agent's first snapshot recorded as two rows (row 1; fixed in b25a48d5). A folder the target holds as a FILE is
   still deleted with all it holds when every file in it is captured (in the undo row) and no link, repository or `.git`
   lies in it (the store's restore comment, WHAT A REWIND REMOVES); a link anywhere in it, inside its `.git` too, refuses
   the rewind (rows 16 and 17), and so does anything no capture took (row 19). A `.git` junction, or a link inside a
   plain `.git` folder, in a folder the target lacks stays where it is with that folder, and so does what it points at
   (row 18). Not covered here: the SSH tar engine
   (environment.js states its scope: links are archived as links; a mount inside the remote root is documented, not
   fixed). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { sidecarSourceFiles, locateSidecarFunction, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

const isWin = process.platform === 'win32';
function runGit(args, opts) {
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-links-')));
const ROOT = path.join(BASE, 'ws');
const links = [];
function link(target, at) {
  if (path.relative(BASE, target).startsWith('..')) throw new Error('fixture link target outside the test folder');
  fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');
  links.push(at);
}
function unlinkLink(at) {
  if (!isWin) fs.unlinkSync(at);
  else {
    try { execFileSync('cmd', ['/c', 'rmdir', at], { windowsHide: true, stdio: 'ignore' }); }   // a junction / directory link
    catch (e) { if (isLink(at)) fs.unlinkSync(at); else throw e; }                              // a file symlink: unlinked, never followed
  }
  const i = links.indexOf(at); if (i >= 0) links.splice(i, 1);
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
function gitInit(dir) {   // an embedded repository with one commit: its own .git in the fixture, never the shadow repo
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false'];
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', id.concat(['add', '-A']), { cwd: dir, stdio: 'ignore' });
  execFileSync('git', id.concat(['commit', '-q', '-m', 'c']), { cwd: dir, stdio: 'ignore' });
}
function fsWith(over) {   // the real fs with some fs.promises calls replaced
  const promises = Object.assign(Object.create(fs.promises), over);
  const out = Object.create(fs);
  Object.defineProperty(out, 'promises', { value: promises });
  return out;
}
function put(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
function bodyOf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }   // null once a rewind deleted it
function outside(name, files) {
  const dir = path.join(BASE, name);
  for (const [rel, body] of Object.entries(files)) put(path.join(dir, rel), body);
  return dir;
}
function listing(dir) {   // every file below dir with its bytes, by path (a fixture's own outside folder: never a link inside)
  const out = {};
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre ? pre + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else out[rel] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}
const gitDirOf = (aid) => path.join(ROOT, '.checkpoints', aid, 'git');
function tree(aid, sha) {
  return execFileSync('git', ['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', sha], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
const rowOf = (store, aid, id) => store.list(aid).snapshots.find((s) => s.id === id) || null;
const linkPaths = (x) => ((x && x.links) || []).map((l) => l.path).sort();

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  try {
    // ================= 1. CAPTURE (probe A): a link's target never enters a restore point =================
    {
      const aid = 'a1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'sub', 'deep', 'mine.txt'), 'mine\n');
      const outA = outside('outA', { 'secret.txt': 'OUTSIDE-A\n' });
      link(outA, path.join(wt, 'jx'));
      link(outA, path.join(wt, 'sub', 'deep', 'jdeep'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'with links' });
      A.ok(s1 && s1.created, 'a work tree holding links still saves a restore point');
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.eq(t1, ['own.txt', 'sub/deep/mine.txt'], 'the snapshot holds the work tree\'s own files and nothing from behind a link');
      A.eq(linkPaths(s1), ['jx', 'sub/deep/jdeep'], 'the result names every link it left out');
      A.eq(s1 && s1.linksTotal, 2, 'and counts them');
      A.eq(linkPaths(rowOf(store, aid, s1 && s1.id)), ['jx', 'sub/deep/jdeep'], 'the index row records the links too');
      // an agent's FIRST snapshot: with no index.json yet, the resilient load rebuilt the commit just made as a lossy row
      // (no runId, no links) that came first and became the new row's own parent (b25a48d5 fixed it)
      const firstRows = store.list(aid).snapshots.filter((s) => s.id === (s1 && s1.id));
      A.eq(firstRows.map((s) => [s.runId, s.parentId === s.id]), [['r', false]], 'an agent\'s first snapshot is one row, with its runId, not its own parent');
      A.ok(store.health(aid) && store.health(aid).ok === true, 'a restore point saved without its links is a working net (health ok)');
      A.eq(listing(outA), { 'secret.txt': 'OUTSIDE-A\n' }, 'the outside folder is untouched');
      // a FILE symlink and a DIRECTORY symlink (Windows needs the symlink privilege or Developer Mode; skipped without it)
      let symlinked = false;
      try {
        fs.symlinkSync(path.join(outA, 'secret.txt'), path.join(wt, 'fl'), 'file'); links.push(path.join(wt, 'fl'));
        fs.symlinkSync(outA, path.join(wt, 'dl'), 'dir'); links.push(path.join(wt, 'dl'));
        symlinked = true;
      } catch (e) { console.log('[skip] file/directory symlinks: ' + e.code); }
      if (symlinked) {
        const sl = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'symlinks too' });
        const tl = sl ? tree(aid, sl.id) : [];
        A.ok(sl && !tl.some((p) => p === 'fl' || p === 'dl' || p.startsWith('dl/')), 'file and directory symlinks are left out like junctions (' + tl.join(',') + ')');
        A.ok(sl && ['dl', 'fl'].every((n) => linkPaths(sl).includes(n)), 'and recorded');
        for (const n of ['fl', 'dl']) { const p = path.join(wt, n); if (isWin && n === 'dl') execFileSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore' }); else fs.unlinkSync(p); links.splice(links.indexOf(p), 1); }
      }
      // a link that went away is captured again as the real folder it now is
      unlinkLink(path.join(wt, 'sub', 'deep', 'jdeep'));
      put(path.join(wt, 'sub', 'deep', 'jdeep', 'real.txt'), 'real now\n');
      const s1b = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'link replaced by a real folder' });
      A.ok(s1b && tree(aid, s1b.id).includes('sub/deep/jdeep/real.txt'), 'a real folder where a link used to be is captured (the exclusion is rewritten every time)');
      A.eq(linkPaths(s1b), ['jx'], 'and only the remaining link is recorded');
      // a link that appears with nothing else changed is its own restore point, not a dedup onto a row that never named it
      const outA2 = outside('outA2', { 'y.txt': 'Y\n' });
      link(outA2, path.join(wt, 'jy'));
      const s1c = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'only a new link' });
      A.ok(s1c && s1c.created && rowOf(store, aid, s1c.id) && linkPaths(rowOf(store, aid, s1c.id)).join() === 'jx,jy', 'a new link alone records a new row naming it');
      const s1d = await store.snapshot(aid, { runId: 'r', turn: 4, label: 'nothing changed' });
      A.ok(s1d && s1d.created === false && s1d.id === s1c.id, 'with the same links and the same files the snapshot still dedups');
    }

    // ================= 2. TRACKED DESCENDANTS (probe B) and a tracked LEAF (probe F) =================
    const aidB = 'b1', wtB = path.join(ROOT, aidB);
    const outB = outside('outB', { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' });
    const outL = outside('outL', { 'x.txt': 'OUTSIDE-L\n' });
    let s2 = null, sLeaf = null;
    {
      put(path.join(wtB, 'keep.txt'), 'keep\n');
      put(path.join(wtB, 'd', 'a.txt'), 'inside-d-a\n');
      put(path.join(wtB, 'L'), 'L-body\n');
      s2 = await store.snapshot(aidB, { runId: 'r', turn: 1, label: 'real d and L' });
      A.eq(s2 ? tree(aidB, s2.id) : [], ['L', 'd/a.txt', 'keep.txt'], 'fixture: d/a.txt and the file L are tracked');
      fs.rmSync(path.join(wtB, 'd'), { recursive: true });
      link(outB, path.join(wtB, 'd'));
      const s3 = await store.snapshot(aidB, { runId: 'r', turn: 2, label: 'd is now a junction' });
      A.ok(s3 && s3.created, 'the next snapshot is saved');
      const t3 = s3 ? tree(aidB, s3.id) : [];
      A.ok(!t3.some((p) => p === 'd' || p.startsWith('d/')), 'a tracked folder swapped for a link is dropped, never re-read through it (' + t3.join(',') + ')');
      A.eq(linkPaths(s3), ['d'], 'and the link is recorded');
      fs.unlinkSync(path.join(wtB, 'L'));
      link(outL, path.join(wtB, 'L'));
      sLeaf = await store.snapshot(aidB, { runId: 'r', turn: 3, label: 'L is now a junction' });
      const tL = sLeaf ? tree(aidB, sLeaf.id) : [];
      A.eq(tL, ['keep.txt'], 'a tracked FILE swapped for a link is dropped too; nothing of its target is read');
      A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB untouched by the captures');
    }

    // ================= 3. RESTORE refuses to write or delete through a link (probes C', F) =================
    {
      const rowsBefore = store.list(aidB).snapshots.length;
      const r = await store.restoreDetailed(aidB, s2.id);   // s2 holds d/a.txt and the file L; both are links now
      A.eq(r && r.ok, false, 'a rewind whose files sit behind a link is refused');
      A.eq(r && r.reason, 'link_in_path', 'with its own reason');
      A.ok(r && /"(d|L)" is a link/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'the refusal names the link and says nothing changed (' + (r && r.detail) + ')');
      A.ok(r && Array.isArray(r.links) && r.links.some((h) => h.link === 'd' && h.path === 'd/a.txt') && r.links.some((h) => h.link === 'L' && h.path === 'L'), 'both the folder case and the leaf case are named');
      A.eq(store.list(aidB).snapshots.length, rowsBefore, 'a refused rewind wrote no pre-restore row: nothing was touched');
      A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB is untouched (C\': b.txt used to be deleted through the junction)');
      A.eq(listing(outL), { 'x.txt': 'OUTSIDE-L\n' }, 'outL is untouched (F: x.txt used to be deleted through the junction)');
      A.ok(isLink(path.join(wtB, 'd')) && isLink(path.join(wtB, 'L')), 'and both links are still where they were');
      // the same work tree, rewound to a point that never had d/ or L: the links stay put and nothing behind them moves
      const rOk = await store.restoreDetailed(aidB, sLeaf.id);
      A.eq(rOk && rOk.ok, true, 'a rewind that passes through no link goes ahead (' + JSON.stringify(rOk) + ')');
      A.eq(linkPaths(rOk), ['L', 'd'], 'and says which links it left where they were');
      A.ok(isLink(path.join(wtB, 'd')) && isLink(path.join(wtB, 'L')), 'the rewind neither removed nor entered a link');
      A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB still whole after a completed rewind');
      A.eq(listing(outL), { 'x.txt': 'OUTSIDE-L\n' }, 'outL still whole after a completed rewind');
    }

    // ================= 4. THE NPM-LINK REWIND (probe E), plain and under a .gitignore'd node_modules =================
    {
      const aid = 'e1', wt = path.join(ROOT, aid);
      const lib = outside('mylib', { 'index.js': 'module.exports = 1;\n', 'src/core.js': 'core\n' });
      const libBefore = listing(lib);
      put(path.join(wt, 'package.json'), '{}\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before npm link' });
      fs.mkdirSync(path.join(wt, 'node_modules'));
      link(lib, path.join(wt, 'node_modules', 'mylib'));
      // a shadow index a pre-fix capture left: `add -A` walked the junction (exactly what trunk d5024f5a did)
      fs.writeFileSync(path.join(gitDirOf(aid), 'info', 'exclude'), '');
      execFileSync('git', ['--git-dir', gitDirOf(aid), '--work-tree', wt, '-c', 'core.autocrlf=false', 'add', '-A'], { cwd: wt, stdio: 'ignore' });
      const legacy = execFileSync('git', ['--git-dir', gitDirOf(aid), 'ls-files'], { encoding: 'utf8' });
      A.ok(/node_modules\/mylib\/index\.js/.test(legacy), 'fixture: the shadow index tracks files behind the junction, as a pre-fix capture left it');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'rewinding while the index tracks files behind the junction is refused (they would be deleted through it)');
      A.ok(r && /"node_modules\/mylib" is a link/.test(r.detail || ''), 'naming the link (' + (r && r.detail) + ')');
      A.eq(listing(lib), libBefore, 'the linked library outside the workspace is whole');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'after npm link' });
      // this rests on the refusal above: on trunk d5024f5a that rewind had already deleted the files behind the link, so
      // the next capture found nothing there to drop (section 2 pins the same drop on a fixture no rewind touched)
      A.ok(s1 && !tree(aid, s1.id).some((p) => p.startsWith('node_modules/')), 'the next capture drops what the old index tracked behind the link, the files still there behind it');
      A.eq(linkPaths(s1), ['node_modules/mylib'], 'and records the link');
      const r2 = await store.restoreDetailed(aid, s0.id);
      A.eq(r2 && r2.ok, true, 'the rewind to before `npm link` then goes ahead');
      A.ok(isLink(path.join(wt, 'node_modules', 'mylib')), 'the link itself is left in place (it was never captured, so removing it could not be undone)');
      A.eq(listing(lib), libBefore, 'and ../mylib keeps index.js and src/core.js');
    }
    {
      // a tracked file below a folder .gitignore now excludes: the walk prunes the folder, the boundary still checks it
      const aid = 'e2', wt = path.join(ROOT, aid);
      const lib2 = outside('mylib2', { 'index.js': 'OUTSIDE-LIB2\n' });
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, 'node_modules', 'mylib', 'index.js'), 'tracked before the ignore rule\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'node_modules tracked' });
      A.ok(s0 && tree(aid, s0.id).includes('node_modules/mylib/index.js'), 'fixture: node_modules/mylib/index.js is tracked');
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      fs.rmSync(path.join(wt, 'node_modules', 'mylib'), { recursive: true });
      link(lib2, path.join(wt, 'node_modules', 'mylib'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'mylib is a junction under an ignored folder' });
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.ok(s1 && !t1.some((p) => p.startsWith('node_modules/')), 'a tracked file under an ignored folder is not re-read through a junction (' + t1.join(',') + ')');
      A.eq(linkPaths(s1), ['node_modules/mylib'], 'the link found below the pruned folder is recorded');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'rewinding to the point that tracked node_modules/mylib/index.js is refused');
      A.eq(listing(lib2), { 'index.js': 'OUTSIDE-LIB2\n' }, 'the outside library is not overwritten');
    }

    // ================= 5. a .gitignore NEGATION cannot re-include a link =================
    {
      const aid = 'n1', wt = path.join(ROOT, aid);
      const outN = outside('outN', { 'n.txt': 'OUTSIDE-N\n' });
      put(path.join(wt, '.gitignore'), '*\n!*/\n!*.txt\n!.gitignore\n');   // an allowlist .gitignore re-includes every folder
      put(path.join(wt, 'own.txt'), 'own\n');
      link(outN, path.join(wt, 'jn'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'allowlist ignore' });
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.eq(t1, ['.gitignore', 'own.txt'], 'the junction stays out even though a negation re-includes it (info/exclude alone lost to `!*/`)');
      put(path.join(wt, 'later.txt'), 'later\n');
      const r = await store.restoreDetailed(aid, s1.id);
      A.eq(r && r.ok, true, 'the rewind goes ahead');
      A.ok(!fs.existsSync(path.join(wt, 'later.txt')), 'a file made after the snapshot is removed as before');
      A.ok(isLink(path.join(wt, 'jn')), 'the re-included link is kept (it was never captured)');
      A.eq(listing(outN), { 'n.txt': 'OUTSIDE-N\n' }, 'and nothing behind it moved');
    }

    // ================= 6. names Git would read as patterns are matched literally =================
    {
      const aid = 'g1', wt = path.join(ROOT, aid);
      const outG = outside('outG', { 'g.txt': 'OUTSIDE-G\n' });
      put(path.join(wt, 'x1', 'f.txt'), 'x1\n');
      put(path.join(wt, 'ab', 'f.txt'), 'ab\n');
      // Windows file names cannot hold * ? : and lose a trailing space, so those three are POSIX-only rows
      const names = ['x[1]', '#h', '!b', 'a b', ' lead'].concat(isWin ? [] : [':colon', 'q*', 'q?', 'trail ']);
      for (const n of names) link(outG, path.join(wt, n));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'pattern names' });
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.eq(t1, ['ab/f.txt', 'x1/f.txt'], 'links named like patterns are left out, and the real folders they resemble are kept (' + t1.join(',') + ')');
      A.eq(linkPaths(s1), names.slice().sort(), 'every one is recorded by its own name');
    }

    // ================= 7. maintenance RE-INIT uses the same boundary =================
    {
      const aid = 'm1', wt = path.join(ROOT, aid);
      const outM = outside('outM', { 'm.txt': 'OUTSIDE-M\n' });
      put(path.join(wt, 'own.txt'), 'own\n');
      link(outM, path.join(wt, 'jx'));
      const tiny = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, maxRepoBytes: 1 });
      const s1 = await tiny.snapshot(aid, { runId: 'r', turn: 1, label: 'over the ceiling' });
      A.ok(s1 && s1.maintenance && s1.maintenance.reinit === true, 'fixture: the size ceiling re-initialised the shadow repo');
      const row = s1 ? rowOf(tiny, aid, s1.id) : null;
      A.ok(row && row.label === 'baseline (re-init)', 'the restore point handed back is the re-init baseline');
      A.eq(s1 ? tree(aid, s1.id) : [], ['own.txt'], 'the fresh baseline holds nothing from behind the link');
      A.eq(linkPaths(row), ['jx'], 'and its row records the link');
    }

    // ================= 8. MOUNT POINTS and other reparse points, as libuv reports them =================
    {
      const aid = 'p1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'mnt', 'on-other-volume.txt'), 'mounted\n');   // a real folder the fake reports as a mount point
      put(path.join(wt, 'cloud.txt'), 'placeholder bytes\n');           // a real file the fake reports as a cloud placeholder
      const mnt = path.join(wt, 'mnt'), cloud = path.join(wt, 'cloud.txt');
      const fakeDirent = (e, kind) => ({ name: e.name, isSymbolicLink: () => kind === 'reparse', isDirectory: () => kind === 'dir', isFile: () => false });
      const promises = Object.create(fs.promises);
      promises.readdir = async (dir, o) => {
        const ents = await fs.promises.readdir(dir, o);
        if (!(o && o.withFileTypes) || path.resolve(String(dir)) !== path.resolve(wt)) return ents;
        return ents.map((e) => (isWin && (e.name === 'mnt' || e.name === 'cloud.txt')) ? fakeDirent(e, 'reparse') : e);
      };
      if (!isWin) {
        const realLstat = fs.promises.lstat.bind(fs.promises);
        promises.lstat = async (p, o) => { const st = await realLstat(p, o); if (path.resolve(String(p)) !== path.resolve(mnt)) return st; return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }); };
      }
      const fakeFs = Object.create(fs);
      Object.defineProperty(fakeFs, 'promises', { value: promises });
      const viaFake = makeCheckpointStore({ fs: fakeFs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const s1 = await viaFake.snapshot(aid, { runId: 'r', turn: 1, label: 'a mount point' });
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.ok(!t1.some((p) => p.startsWith('mnt/')), 'a mount point (a reparse point lstat reads as a plain folder) is never entered (' + t1.join(',') + ')');
      A.ok(s1 && (s1.links || []).some((l) => l.path === 'mnt' && l.kind === 'mount-point'), 'and is recorded as a mount point');
      if (isWin) {
        A.ok(t1.includes('cloud.txt') && !(s1.links || []).some((l) => l.path === 'cloud.txt'), 'a reparse FILE lstat reads as a plain file (a cloud placeholder) is captured like any file');
      }
      void cloud;
    }
    {
      // 8b. a DANGLING mount point: libuv's lstat follows a reparse point it cannot read as a link (a mount point named by
      // volume GUID), so a dangling one answers ENOENT. It was 'gone': neither left out nor recorded, and not refused
      const aid = 'p2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'vol', 'data.txt'), 'data\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'vol is a folder' });
      fs.rmSync(path.join(wt, 'vol'), { recursive: true });
      const phantom = { name: 'vol', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      const viaFake = makeCheckpointStore({ fs: fsWith({ readdir: async (dir, o) => {
        const ents = await fs.promises.readdir(dir, o);
        return (o && o.withFileTypes && path.resolve(String(dir)) === path.resolve(wt)) ? ents.concat([phantom]) : ents;
      } }), pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const s1 = await viaFake.snapshot(aid, { runId: 'r', turn: 2, label: 'vol is a dangling mount point' });
      A.ok(s1 && (s1.links || []).some((l) => l.path === 'vol'), 'a reparse point lstat cannot find is recorded as a link (' + JSON.stringify(s1 && s1.links) + ')');
      const rows = viaFake.list(aid).snapshots.length;
      const r = await viaFake.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'and a rewind that would write through it is refused, naming it (' + JSON.stringify(r) + ')');
      A.eq(viaFake.list(aid).snapshots.length, rows, 'before anything is touched: no pre-restore row');
      A.ok(!fs.existsSync(path.join(wt, 'vol')), 'and nothing was written where it stands');
    }

    // ================= 9. the BUDGET: an honest skip, never a hang, and a link target is never walked =================
    {
      const aid = 'q1', wt = path.join(ROOT, aid);
      for (let i = 0; i < 12; i++) put(path.join(wt, 'f' + i + '.txt'), 'f' + i + '\n');
      const small = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 5 });
      const s = await small.snapshot(aid, { runId: 'r', turn: 1, label: 'over the entry budget' });
      A.eq(s, null, 'over the entry budget the restore point is skipped');
      const why = small.health(aid) && small.health(aid).lastFailure && small.health(aid).lastFailure.reason;
      A.ok(/could not be checked for links/.test(why || '') && /more than 5 files and folders/.test(why || ''), 'and health says why (' + why + ')');
      const ok = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'normal budget' });
      const rr = await small.restoreDetailed(aid, ok.id);
      A.eq(rr && rr.reason, 'link_check_failed', 'a rewind the walk cannot finish is refused, not run unchecked');
      put(path.join(wt, 'a', 'b', 'c', 'd', 'deep.txt'), 'deep\n');
      const shallow = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxDepth: 2 });
      A.eq(await shallow.snapshot(aid, { runId: 'r', turn: 3 }), null, 'over the depth budget the restore point is skipped');
      A.ok(/deeper than 2 levels/.test(shallow.health(aid).lastFailure.reason), 'and health says so (' + shallow.health(aid).lastFailure.reason + ')');
      let t = 0;
      const slow = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanDeadlineMs: 1000, scanClock: { now: () => (t += 60000) } });
      A.eq(await slow.snapshot(aid, { runId: 'r', turn: 4 }), null, 'over the time budget the restore point is skipped');
      A.ok(/took longer than 1 s/.test(slow.health(aid).lastFailure.reason), 'and health says so (' + slow.health(aid).lastFailure.reason + ')');
      // a junction to a big synthetic tree: the walk never lists it, so a small entry budget is enough
      const big = path.join(BASE, 'big');
      for (let d = 0; d < 30; d++) for (let f = 0; f < 100; f++) put(path.join(big, 'd' + d, 'f' + f + '.txt'), 'x');
      const aid2 = 'q2', wt2 = path.join(ROOT, aid2);
      put(path.join(wt2, 'own.txt'), 'own\n');
      link(big, path.join(wt2, 'big'));
      const budgeted = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 50 });
      const sb = await budgeted.snapshot(aid2, { runId: 'r', turn: 1, label: 'a junction to 3000 files' });
      A.ok(sb && sb.created && tree(aid2, sb.id).join() === 'own.txt', 'a junction to 3000 files costs the walk one entry (budget 50): it is never entered');
      // a .gitignore'd folder is not walked (Git never enters it either), unless a negation could re-include the folder
      const aid3 = 'q3', wt3 = path.join(ROOT, aid3);
      put(path.join(wt3, 'own.txt'), 'own\n');
      for (let i = 0; i < 80; i++) put(path.join(wt3, 'node_modules', 'pkg', 'f' + i + '.js'), 'x');
      put(path.join(wt3, '.gitignore'), 'node_modules/\r\n.vscode/*\r\n!.vscode/settings.json\r\n');
      const pruning = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 40 });
      const sp = await pruning.snapshot(aid3, { runId: 'r', turn: 1, label: 'ignored node_modules' });
      A.ok(sp && sp.created, 'an ignored node_modules (80 files, budget 40) is not walked; a negation that cannot re-include it does not change that');
      put(path.join(wt3, '.gitignore'), 'node_modules/\n!node_modules/\n');
      A.eq(await pruning.snapshot(aid3, { runId: 'r', turn: 2, label: 're-included' }), null, 'a negation that re-includes the folder makes the walk enter it (here: over budget, said)');
    }

    // ================= 10. the SSH mirror wipe, the scope statements and the residual =================
    {
      const holder = path.join(BASE, 'mirror'), target = outside('mirrorTarget', { 't.txt': 'T\n' });
      put(path.join(holder, 'sub', 'keep.txt'), 'k\n');
      link(target, path.join(holder, 'sub', 'jt'));
      link(target, path.join(holder, 'jtop'));
      for (const name of fs.readdirSync(holder)) fs.rmSync(path.join(holder, name), { recursive: true, force: true });   // environment.js restoreCheckpoint's wipe
      for (const gone of [path.join(holder, 'sub', 'jt'), path.join(holder, 'jtop')]) { const i = links.indexOf(gone); if (i >= 0 && !fs.existsSync(gone) && !isLink(gone)) links.splice(i, 1); }
      A.eq(listing(target), { 't.txt': 'T\n' }, 'the SSH engine\'s local mirror wipe (fs.rmSync) unlinks a junction without entering it');
      const env = sidecarFunctionSource('createCheckpointRaw');
      // the scope comment is the one right above createCheckpointRaw in environment.js, not the phrase anywhere in sidecar/
      const at = locateSidecarFunction('createCheckpointRaw');
      const envText = at ? ((sidecarSourceFiles().find((f) => f.rel === at.rel) || {}).text || '') : '';
      const above = at ? envText.slice(envText.lastIndexOf('/*', at.index), at.index) : '';
      A.ok(at && at.rel === 'sidecar/environment.js' && /^\/\* THE SSH CHECKPOINT ENGINE AND LINKS/.test(above) && /tar -cf ' \+ quote\(archive\)/.test(env) && !/tar -[a-zA-Z]*h|--dereference/.test(env), 'the SSH engine states its link scope above createCheckpointRaw, and its tar never dereferences a link');
      const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'checkpoint-store.js'), 'utf8');
      const header = storeSrc.slice(0, storeSrc.indexOf("'use strict';"));
      A.ok(/TOCTOU/.test(header) && /checkpoint-manifest/.test(header) && /W2-link-junction-containment/.test(header), 'the store header documents the TOCTOU residual and the Tier 2 lane');
      const route = sidecarTopLevelFunction('handleCheckpointRestore');
      A.ok(/out\.reason === 'link_in_path' \|\| out\.reason === 'link_check_failed'\)\) return json\(409, \{ error: 'restore refused: ' \+ String\(out\.detail/.test(route),
        'the restore route answers a link refusal 409 in the store\'s own words (it would have fallen through to "no such snapshot")');
    }

    // ================= 11. a FOLDER the target holds as a FILE (probe P8): reset empties that folder through its links =================
    {
      const aid = 'r1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'a'), 'a was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'a is a file' });
      fs.unlinkSync(path.join(wt, 'a'));
      put(path.join(wt, 'a', 'b', 'real.txt'), 'real\n');
      const outR = outside('outR', { 'o.txt': 'OUTSIDE-R\n', 'deep/d.txt': 'D\n' });
      link(outR, path.join(wt, 'a', 'b', 'jl'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'a is a folder holding a link' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['a/b/real.txt', 'own.txt'], 'fixture: a/b/jl is left out of the capture');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'a rewind that turns the folder holding a link back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(r && /"a\/b\/jl" is a link/.test(r.detail || '') && /folder "a"/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'naming the link and the folder');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(outR), { 'deep/d.txt': 'D\n', 'o.txt': 'OUTSIDE-R\n' }, 'the outside folder is whole (reset used to empty it through the junction)');
      A.ok(fs.lstatSync(path.join(wt, 'a')).isDirectory() && isLink(path.join(wt, 'a', 'b', 'jl')), 'the folder and its link are where they were');
    }
    {
      // the same for a folder the walk prunes (an ignored build/) and an embedded repository, each in a work tree of its
      // own (together, the embedded repository's capture failure before round 2 hid the build/ deletion): each is
      // listed in full on demand
      const aid = 'r2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'build'), 'build was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt, 'build'));
      put(path.join(wt, '.gitignore'), 'build/\n');
      put(path.join(wt, 'build', 'out.txt'), 'built\n');
      const outB2 = outside('outB2', { 'b.txt': 'OUTSIDE-B2\n' }), outP2 = outside('outP2', { 'p.txt': 'OUTSIDE-P2\n' });
      link(outB2, path.join(wt, 'build', 'jl'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'an ignored build/' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['.gitignore', 'own.txt'], 'fixture: build/ is ignored');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning an ignored folder that holds a link back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(((r && r.links) || []).some((h) => h.path === 'build' && h.link === 'build/jl'), 'the link in it is found and named');
      A.eq(listing(outB2), { 'b.txt': 'OUTSIDE-B2\n' }, 'the folder behind the ignored link is whole');
      const aidP = 'r2p', wtP = path.join(ROOT, aidP);
      put(path.join(wtP, 'own.txt'), 'own\n');
      put(path.join(wtP, 'proj'), 'proj was a file\n');
      const p0 = await store.snapshot(aidP, { runId: 'r', turn: 1, label: 'proj is a file' });
      fs.unlinkSync(path.join(wtP, 'proj'));
      put(path.join(wtP, 'proj', 'f.txt'), 'f\n');
      gitInit(path.join(wtP, 'proj'));
      link(outP2, path.join(wtP, 'proj', 'jl'));
      const p1 = await store.snapshot(aidP, { runId: 'r', turn: 2, label: 'a cloned proj/' });
      A.eq(p1 ? tree(aidP, p1.id) : [], ['own.txt', 'proj'], 'fixture: proj/ is one gitlink');
      const rp = await store.restoreDetailed(aidP, p0.id);
      A.eq(rp && rp.reason, 'link_in_path', 'turning an embedded repository that holds a link back into a file is refused (' + JSON.stringify(rp) + ')');
      A.ok(((rp && rp.links) || []).some((h) => h.path === 'proj' && h.link === 'proj/jl'), 'the link in it is found and named');
      A.eq(listing(outP2), { 'p.txt': 'OUTSIDE-P2\n' }, 'the folder behind the link in the embedded repository is whole');
    }

    // ================= 12. a rewind keeps every link and never-captured folder, whatever the target's .gitignore says (no clean) =================
    {
      // P2: the target's allowlist .gitignore re-includes every folder, a link only info/exclude kept out among them
      const aid = 'k1', wt = path.join(ROOT, aid);
      put(path.join(wt, '.gitignore'), '*\n!*/\n!*.txt\n!.gitignore\n');
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'allowlist .gitignore' });
      fs.unlinkSync(path.join(wt, '.gitignore'));
      const outK = outside('outK', { 'n.txt': 'OUTSIDE-K\n', 'deep/m.txt': 'M\n' });
      link(outK, path.join(wt, 'jn'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no .gitignore, a junction' });
      A.eq(linkPaths(s1), ['jn'], 'fixture: the junction is recorded');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'the rewind goes ahead (' + JSON.stringify(r) + ')');
      A.ok(fs.existsSync(path.join(wt, '.gitignore')), 'and wrote the target\'s .gitignore back');
      A.ok(isLink(path.join(wt, 'jn')), 'the link that .gitignore re-includes is kept (clean used to unlink it)');
      A.eq(linkPaths(r), ['jn'], 'so the links the result says it left where they were are really there');
      A.eq(listing(outK), { 'deep/m.txt': 'M\n', 'n.txt': 'OUTSIDE-K\n' }, 'and nothing behind it moved');
    }
    {
      // P1: a link, and an ignored file, in a folder only the CURRENT .gitignore ignores
      const aid = 'k2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before npm install' });
      const libK = outside('libK', { 'index.js': 'LIB-K\n', 'src/core.js': 'CORE-K\n' });
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      put(path.join(wt, 'node_modules', '.package-lock.json'), '{}\n');
      link(libK, path.join(wt, 'node_modules', 'mylib'));
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'npm install ../mylib' });
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'the rewind to before the .gitignore goes ahead (' + JSON.stringify(r) + ')');
      A.ok(!fs.existsSync(path.join(wt, '.gitignore')), 'the .gitignore the target lacks is gone');
      A.ok(isLink(path.join(wt, 'node_modules', 'mylib')), 'the link in the folder only that .gitignore ignored is kept');
      A.ok(fs.existsSync(path.join(wt, 'node_modules', '.package-lock.json')), 'and so is the ignored file beside it: it was never captured, so removing it could not be undone');
      A.eq(listing(libK), { 'index.js': 'LIB-K\n', 'src/core.js': 'CORE-K\n' }, 'the linked library is whole');
    }

    // ================= 13. EMBEDDED REPOSITORIES: Git records a gitlink and never reads inside, and neither does the walk =================
    {
      const aid = 'c1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own 0\n');
      put(path.join(wt, 'clone', 'README'), 'r\n');
      for (let i = 0; i < 60; i++) put(path.join(wt, 'clone', 'src', 'f' + i + '.js'), 'x');
      gitInit(path.join(wt, 'clone'));
      const outC = outside('outC', { 'x.txt': 'OUTSIDE-C\n' });
      fs.mkdirSync(path.join(wt, 'clone', 'sub'));
      link(outC, path.join(wt, 'clone', 'sub', 'j'));
      const ids = [];
      for (let i = 1; i <= 3; i++) {
        put(path.join(wt, 'own.txt'), 'own ' + i + '\n');
        const s = await store.snapshot(aid, { runId: 'r', turn: i, label: 'turn ' + i });
        A.ok(s && s.created && store.health(aid).ok === true, 'snapshot ' + i + ' of a workspace holding a clone with a junction is saved (' + JSON.stringify(store.health(aid).lastFailure) + ')');
        if (s) ids.push(s.id);
      }
      A.eq(ids.length ? tree(aid, ids[0]) : [], ['clone', 'own.txt'], 'the clone is one gitlink');
      A.eq(linkPaths(rowOf(store, aid, ids[2])), [], 'and no link inside it is recorded: Git never reads there');
      const r = await store.restoreDetailed(aid, ids[0]);
      A.eq(r && r.ok, true, 'a rewind goes ahead (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'own.txt'), 'utf8'), 'own 1\n', 'and rewinds the workspace');
      A.ok(isLink(path.join(wt, 'clone', 'sub', 'j')) && fs.existsSync(path.join(wt, 'clone', '.git', 'HEAD')), 'the clone and its link are untouched');
      A.eq(listing(outC), { 'x.txt': 'OUTSIDE-C\n' }, 'and nothing behind the link moved');
      put(path.join(wt, 'own.txt'), 'own 4\n');
      const small = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 30 });
      const sb = await small.snapshot(aid, { runId: 'r', turn: 4, label: 'budget 30' });
      A.ok(sb && sb.created, 'the clone\'s 60 files cost the walk nothing (budget 30): it is never entered');
    }
    {
      // a `git init` in a folder the shadow repo already tracks: Git keeps reading it as a folder, so the walk enters it too
      const aid = 'c2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app', 'a.txt'), 'a\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'app tracked' });
      gitInit(path.join(wt, 'app'));
      const outC2 = outside('outC2', { 'y.txt': 'OUTSIDE-C2\n' });
      link(outC2, path.join(wt, 'app', 'jl'));
      put(path.join(wt, 'app', 'b.txt'), 'b\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'git init in app' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['app/a.txt', 'app/b.txt'], 'Git still captures the folder\'s files, and nothing from behind its link');
      A.eq(linkPaths(s1), ['app/jl'], 'because the walk entered the folder and left the link out');
    }
    {
      // an embedded repository whose .git went away: the index still holds the gitlink, so Git still never reads inside
      const aid = 'c3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own 0\n');
      put(path.join(wt, 'proj', 'f.txt'), 'f\n');
      gitInit(path.join(wt, 'proj'));
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'proj is a gitlink' });
      fs.rmSync(path.join(wt, 'proj', '.git'), { recursive: true, force: true });
      const outC3 = outside('outC3', { 'z.txt': 'OUTSIDE-C3\n' });
      link(outC3, path.join(wt, 'proj', 'jl'));
      put(path.join(wt, 'own.txt'), 'own 1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj lost its .git and holds a junction' });
      A.ok(s1 && s1.created && store.health(aid).ok === true, 'the snapshot is saved: a link below a gitlink is outside Git\'s view (' + JSON.stringify(store.health(aid).lastFailure) + ')');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'and a rewind goes ahead (' + JSON.stringify(r) + ')');
      A.ok(isLink(path.join(wt, 'proj', 'jl')), 'leaving the link in place');
      A.eq(listing(outC3), { 'z.txt': 'OUTSIDE-C3\n' }, 'with nothing behind it moved');
    }

    // ================= 14. the recorded links do not depend on the order the folders were listed in =================
    {
      const aid = 'o1', wt = path.join(ROOT, aid);
      const outO = outside('outO', { 'x.txt': 'x\n' });
      const dirs = ['a', 'b', 'c', 'd'];
      for (const d of dirs) { put(path.join(wt, d, 'f.txt'), d + '\n'); link(outO, path.join(wt, d, 'j')); }
      // the four folders finish listing in a different order on every snapshot (as a loaded thread pool may)
      let round = 0;
      const jittered = fsWith({ readdir: async (dir, o) => {
        const rel = path.relative(wt, String(dir)), i = dirs.indexOf(rel);
        if (rel === '') round++;
        if (i >= 0) await new Promise((res) => setTimeout(res, ((i + round) % 4) * 15));
        return fs.promises.readdir(dir, o);
      } });
      const st = makeCheckpointStore({ fs: jittered, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const first = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'four links' });
      A.eq(((first && first.links) || []).map((l) => l.path), ['a/j', 'b/j', 'c/j', 'd/j'], 'the links are recorded in path order');
      for (let i = 0; i < 3; i++) {
        const s = await st.snapshot(aid, { runId: 'r', turn: 2 + i, label: 'unchanged ' + i });
        A.ok(s && s.created === false && s.id === first.id, 'an unchanged tree dedups whatever order its folders were listed in (' + i + ': ' + JSON.stringify(s && { created: s.created, links: s.links }) + ')');
      }
      A.eq(st.list(aid).snapshots.length, 1, 'one row, not one per snapshot');
    }

    // ================= 15. POSIX: a work-tree root that is itself a link to another file system =================
    {
      const aid = 'x1', wt = path.join(ROOT, aid);
      for (const [rel, body] of [['own.txt', 'o'], ['src/a.js', 'a'], ['docs/b.md', 'b']]) put(path.join(wt, rel), body);
      // the POSIX branch (sep '/', also on Windows), whose lstat of the root reports the link's own device (dev + 1)
      const sameAsRoot = (p) => path.resolve(String(p)).toLowerCase() === path.resolve(wt).toLowerCase();
      const linkedRoot = fsWith({ lstat: async (p, o) => {
        const st = await fs.promises.lstat(p, o);
        return sameAsRoot(p) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
      } });
      const posixish = isWin ? Object.assign({}, path.win32, { sep: '/' }) : path;
      const st = makeCheckpointStore({ fs: linkedRoot, pathMod: posixish, root: ROOT, runGit, clock, keep: 50 });
      const s = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'root through a link' });
      A.eq(s ? tree(aid, s.id) : [], ['docs/b.md', 'own.txt', 'src/a.js'], 'every folder is captured: the root\'s device is read through the link (it made every folder a mount point)');
      A.eq(linkPaths(s), [], 'and none is recorded as a link');
    }

    // ================= 16. review round 3: P8 at any depth, `.git` links, Git's own gitfile parse, the clean's bound =================
    {
      // P8 one level INSIDE a folder the walk does not enter: the target holds FILES at build/sub (build/ is ignored now)
      // and proj/sub (proj is an embedded clone now), and each of those folders now holds a junction
      const aid = 'd1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'build', 'sub'), 'build/sub was a file\n');
      put(path.join(wt, 'proj', 'sub'), 'proj/sub was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build/sub and proj/sub are files' });
      fs.rmSync(path.join(wt, 'proj'), { recursive: true });
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj gone' });   // so the clone below is untracked: one gitlink
      fs.unlinkSync(path.join(wt, 'build', 'sub'));
      put(path.join(wt, '.gitignore'), 'build/\n');
      put(path.join(wt, 'build', 'sub', 'k.txt'), 'k\n');
      const outD1 = outside('outD1', { 'b.txt': 'OUTSIDE-D1\n', 'deep/m.txt': 'M\n' });
      const outD2 = outside('outD2', { 'p.txt': 'OUTSIDE-D2\n', 'deep/m.txt': 'M\n' });
      link(outD1, path.join(wt, 'build', 'sub', 'jl'));
      put(path.join(wt, 'proj', 'README'), 'clone\n');
      put(path.join(wt, 'proj', 'sub', 'k.txt'), 'k\n');
      gitInit(path.join(wt, 'proj'));
      link(outD2, path.join(wt, 'proj', 'sub', 'jl'));
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'build ignored, proj a clone, each sub/ holding a junction' });
      A.eq(s2 ? tree(aid, s2.id) : [], ['.gitignore', 'own.txt', 'proj'], 'fixture: build/ is ignored and proj/ is one gitlink');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder INSIDE an ignored folder or an embedded repository back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'build/sub' && h.link === 'build/sub/jl') && named.some((h) => h.path === 'proj/sub' && h.link === 'proj/sub/jl'), 'naming both folders and their links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(outD1), { 'b.txt': 'OUTSIDE-D1\n', 'deep/m.txt': 'M\n' }, 'the folder behind the junction in the ignored build/sub is whole (reset emptied it)');
      A.eq(listing(outD2), { 'deep/m.txt': 'M\n', 'p.txt': 'OUTSIDE-D2\n' }, 'the folder behind the junction in the clone\'s proj/sub is whole (reset emptied it)');
    }
    {
      // a `.git` that is ITSELF a link, in a folder the walk enters, where the target holds a FILE: Git never reads a `.git`,
      // so it was never a recorded link, but reset empties the folder through it. x/.git: a relocated git-dir (a real
      // repository's .git, linked back; x is tracked); y/.git: a junction to a plain folder (y is untracked)
      const aid = 'd2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'x'), 'x was a file\n');
      put(path.join(wt, 'y'), 'y was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x and y are files' });
      fs.unlinkSync(path.join(wt, 'x'));
      fs.unlinkSync(path.join(wt, 'y'));
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x a tracked folder' });
      const repo = outside('repoD2', { 'r.txt': 'r\n' });
      gitInit(repo);
      const repoGit = path.join(repo, '.git'), gitFiles = Object.keys(listing(repoGit)).length;
      link(repoGit, path.join(wt, 'x', '.git'));
      put(path.join(wt, 'y', 'g.txt'), 'g\n');
      const outY = outside('outD2y', { 'y.txt': 'OUTSIDE-Y\n', 'deep/m.txt': 'M\n' });
      link(outY, path.join(wt, 'y', '.git'));
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'x/.git and y/.git are junctions' });
      A.eq(s2 ? tree(aid, s2.id) : [], ['own.txt', 'x/f.txt', 'y/g.txt'], 'fixture: both folders are walked and captured, no `.git` content');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder whose `.git` is a link back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'x' && h.link === 'x/.git') && named.some((h) => h.path === 'y' && h.link === 'y/.git'), 'naming both `.git` links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(repoGit, 'HEAD')) && Object.keys(listing(repoGit)).length === gitFiles, 'the relocated git-dir is whole (reset deleted every file of it, HEAD too)');
      A.eq(listing(outY), { 'deep/m.txt': 'M\n', 'y.txt': 'OUTSIDE-Y\n' }, 'the folder behind y/.git is whole');
    }
    {
      // a `.git` FILE that Git does not read as a gitfile (setup.c read_gitfile_gently: exactly "gitdir: ", then the whole
      // rest of the file minus its trailing CR/LF): Git reads that folder like any other, so the walk must enter it too
      const aid = 'd3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const repo = outside('repoD3', { 'r.txt': 'r\n' });
      gitInit(repo);
      const gd = path.join(repo, '.git').replace(/\\/g, '/');
      const outG = outside('outD3', { 'secret.txt': 'OUTSIDE-D3\n' });
      const gitfiles = {
        good: 'gitdir: ' + gd + '\r\n',                    // the control: an exact gitfile, an embedded repository to Git
        nospace: 'gitdir:' + gd + '\n', twospace: 'gitdir:  ' + gd + '\n', tab: 'gitdir:\t' + gd + '\n', twolines: 'gitdir: ' + gd + '\nextra\n'
      };
      for (const [name, body] of Object.entries(gitfiles)) {
        put(path.join(wt, name, 'README'), name + '\n');
        put(path.join(wt, name, '.git'), body);
        link(outG, path.join(wt, name, 'jl'));
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'gitfiles Git reads and does not' });
      const t1 = s1 ? tree(aid, s1.id) : [];
      A.ok(!t1.some((p) => /\/jl(\/|$)/.test(p)), 'nothing from behind a link is captured (' + t1.join(',') + ')');
      A.eq(t1, ['good', 'nospace/README', 'own.txt', 'tab/README', 'twolines/README', 'twospace/README'], 'the folders Git reads are captured, and the exact gitfile is one gitlink');
      A.eq(linkPaths(s1), ['nospace/jl', 'tab/jl', 'twolines/jl', 'twospace/jl'], 'the links in the folders Git reads are left out and recorded');
      A.eq(listing(outG), { 'secret.txt': 'OUTSIDE-D3\n' }, 'the outside folder is untouched');
    }
    {
      // an ordinary tree with hundreds of ignored folders and no link: a rewind keeps them (round 2's clean needed one
      // pattern per folder, 700 went past its bound and every rewind was refused; round 5 removed the clean)
      const aid = 'd4', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.py'), 'v0\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before the packages' });
      put(path.join(wt, '.gitignore'), '__pycache__/\n');
      put(path.join(wt, 'app.py'), 'v1\n');
      const pkg = (i) => 'package_module_' + String(i).padStart(3, '0');
      for (let i = 0; i < 700; i++) {
        put(path.join(wt, pkg(i), 'mod.py'), 'm\n');
        put(path.join(wt, pkg(i), '__pycache__', 'mod.cpython-312.pyc'), 'pyc\n');
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: '700 packages' });
      A.ok(s1 && s1.created && !tree(aid, s1.id).some((p) => p.includes('__pycache__')), 'fixture: 700 ignored __pycache__ folders, none captured');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind goes ahead (it was refused: more ignored folders than a rewind can keep) (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'app.py'), 'utf8'), 'v0\n', 'and rewinds');
      A.ok(!fs.existsSync(path.join(wt, '.gitignore')) && !fs.existsSync(path.join(wt, pkg(0), 'mod.py')), 'removing what the target lacks');
      A.ok([0, 350, 699].every((i) => fs.existsSync(path.join(wt, pkg(i), '__pycache__', 'mod.cpython-312.pyc'))),
        'while every never-captured ignored folder stays, though the target has no .gitignore to ignore it');
    }

    // ================= 17. review round 4: a link inside a real `.git` folder, and the clean's bound by folder name =================
    {
      // the target holds proj as a FILE; proj is now an embedded clone whose .git/hooks is a junction to a shared hooks
      // folder. entry.c remove_subtree has no case for `.git`: reset emptied the hooks folder through it and said ok
      const aid = 'g4', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'proj'), 'proj was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'proj is a file' });
      fs.unlinkSync(path.join(wt, 'proj'));
      put(path.join(wt, 'proj', 'README'), 'clone\n');
      gitInit(path.join(wt, 'proj'));
      const hooks = outside('outG4', { 'pre-commit': 'SHARED-HOOK\n', 'deep/m.txt': 'M\n' });
      fs.rmSync(path.join(wt, 'proj', '.git', 'hooks'), { recursive: true, force: true });
      link(hooks, path.join(wt, 'proj', '.git', 'hooks'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj a clone, its hooks linked' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['own.txt', 'proj'], 'fixture: proj is one gitlink');
      A.eq(linkPaths(s1), [], 'and no link inside its `.git` is recorded: Git never reads there');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a clone whose .git/hooks is a junction back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(((r && r.links) || []).some((h) => h.path === 'proj' && h.link === 'proj/.git/hooks'), 'naming the folder and the link inside its `.git`');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(hooks), { 'deep/m.txt': 'M\n', 'pre-commit': 'SHARED-HOOK\n' }, 'the shared hooks folder is whole (reset emptied it)');
      A.ok(isLink(path.join(wt, 'proj', '.git', 'hooks')) && fs.existsSync(path.join(wt, 'proj', '.git', 'HEAD')), 'the clone and its link are where they were');
    }
    {
      // a walked folder whose `.git` is a plain folder (no repository), with nothing else to check in the whole tree: the
      // target holds x and w as FILES, and x/.git/lfs and w/sub/.git/modules/m (two folders inside a `.git`, one folder
      // below the one replaced) are junctions. The check used to return before asking any folder
      const aid = 'g5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'x'), 'x was a file\n');
      put(path.join(wt, 'w'), 'w was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x and w are files' });
      fs.unlinkSync(path.join(wt, 'x'));
      fs.unlinkSync(path.join(wt, 'w'));
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'x', '.git'));
      const lfs = outside('outG5x', { 'objects/aa.bin': 'LFS-OBJECT\n', 'deep/m.txt': 'M\n' });
      link(lfs, path.join(wt, 'x', '.git', 'lfs'));
      put(path.join(wt, 'w', 'sub', 'g.txt'), 'g\n');
      fs.mkdirSync(path.join(wt, 'w', 'sub', '.git', 'modules'), { recursive: true });
      const mod = outside('outG5w', { 'm.txt': 'OUTSIDE-W\n' });
      link(mod, path.join(wt, 'w', 'sub', '.git', 'modules', 'm'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x and w are folders, links inside their .git' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['own.txt', 'w/sub/g.txt', 'x/f.txt'], 'fixture: both folders are walked, nothing of a `.git` is captured');
      A.eq(linkPaths(s1), [], 'and no link inside a `.git` is recorded');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder whose `.git` holds a link back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'x' && h.link === 'x/.git/lfs') && named.some((h) => h.path === 'w' && h.link === 'w/sub/.git/modules/m'), 'naming both links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(lfs), { 'deep/m.txt': 'M\n', 'objects/aa.bin': 'LFS-OBJECT\n' }, 'the folder behind x/.git/lfs is whole (reset emptied it)');
      A.eq(listing(mod), { 'm.txt': 'OUTSIDE-W\n' }, 'the folder behind w/sub/.git/modules/m is whole');
    }
    {
      // the control: a rewind that replaces no folder goes ahead past a link inside a `.git`, and leaves both alone
      const aid = 'g7', wt = path.join(ROOT, aid);
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'x', '.git'));
      const lfs = outside('outG7', { 'objects/aa.bin': 'LFS-OBJECT\n' });
      link(lfs, path.join(wt, 'x', '.git', 'lfs'));
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x/f.txt' });
      put(path.join(wt, 'x', 'g.txt'), 'g\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x/g.txt added' });
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind that replaces no folder is not refused by a link inside a `.git` (' + JSON.stringify(r) + ')');
      A.ok(!fs.existsSync(path.join(wt, 'x', 'g.txt')) && isLink(path.join(wt, 'x', '.git', 'lfs')), 'it rewinds, and the link stays');
      A.eq(listing(lfs), { 'objects/aa.bin': 'LFS-OBJECT\n' }, 'with nothing behind it moved');
    }
    {
      // a monorepo whose 400 packages each list their own build folders in their own .gitignore (one rule anchored, two
      // not), names the root .gitignore lacks, and no link: one clean pattern per rule base was 1200 patterns, past the
      // bound, so every rewind was refused (round 4: one per folder NAME; round 5: no clean at all)
      const aid = 'g6', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{"v":0}\n');
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before the packages' });
      put(path.join(wt, 'package.json'), '{"v":1}\n');
      const pkg = (i) => path.join(wt, 'packages', 'pkg-' + String(i).padStart(4, '0'));
      for (let i = 0; i < 400; i++) {
        put(path.join(pkg(i), 'package.json'), '{}\n');
        put(path.join(pkg(i), '.gitignore'), '/dist/\n.turbo/\ncoverage/\n');
        for (const n of ['dist', '.turbo', 'coverage']) put(path.join(pkg(i), n, 'out.txt'), 'built\n');
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: '400 packages' });
      A.ok(s1 && s1.created && !tree(aid, s1.id).some((p) => /\/(dist|\.turbo|coverage)\//.test(p)), 'fixture: 1200 ignored folders under 400 package .gitignore files, none captured');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind goes ahead (it was refused: more ignored folders than a rewind can keep) (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'package.json'), 'utf8'), '{"v":0}\n', 'and rewinds');
      A.ok(!fs.existsSync(path.join(pkg(0), 'package.json')) && !fs.existsSync(path.join(pkg(399), '.gitignore')), 'removing what the target lacks');
      A.ok([0, 200, 399].every((i) => ['dist', '.turbo', 'coverage'].every((n) => fs.existsSync(path.join(pkg(i), n, 'out.txt')))),
        'while every never-captured ignored folder stays, anchored rule or not, though no .gitignore is left to ignore it');
    }

    // ================= 18. review round 5: a rewind deletes no file no capture took; `.git` links in a folder the target lacks; Git's own count =================
    {
      // the target has no .gitignore; now .env, src/y.log (a glob rule) and tmp-1/k.txt (a glob folder rule) are ignored, so
      // no capture took them. reset wrote the target's tree (no .gitignore), then `clean -fd` deleted all three for good,
      // undo or not (trunk d5024f5a did the same)
      const aid = 'v1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before .gitignore' });
      put(path.join(wt, '.gitignore'), '.env\n*.log\ntmp-*/\n');
      put(path.join(wt, '.env'), 'API_KEY=fixture-only\n');
      put(path.join(wt, 'src', 'y.log'), 'log\n');
      put(path.join(wt, 'tmp-1', 'k.txt'), 'k\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      put(path.join(wt, 'added', 'deep', 'n.txt'), 'n\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'a .gitignore, .env and logs' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['.gitignore', 'added/deep/n.txt', 'app.js'], 'fixture: no capture took .env, src/y.log or tmp-1/k.txt');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'the rewind to before the .gitignore goes ahead (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'app.js'), 'utf8'), 'v0\n', 'and rewinds');
      A.ok(!fs.existsSync(path.join(wt, '.gitignore')) && !fs.existsSync(path.join(wt, 'added')), 'removing the captured files the target lacks, and the folders that left empty');
      A.eq(fs.existsSync(path.join(wt, '.env')) ? fs.readFileSync(path.join(wt, '.env'), 'utf8') : null, 'API_KEY=fixture-only\n',
        'the .env no capture took is intact, though the target has no .gitignore to ignore it (clean deleted it for good)');
      A.ok(fs.existsSync(path.join(wt, 'src', 'y.log')) && fs.existsSync(path.join(wt, 'tmp-1', 'k.txt')), 'and so are the file a glob rule ignored and the folder another ignored');
      const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, 'the undo goes ahead (' + JSON.stringify(u) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'app.js'), 'utf8'), 'v1\n', 'and brings the captured state back');
      // the undo is a rewind under the target's rules (no .gitignore): its own capture took .env, and its reset removed it
      // (the target, s1, lacks it). It is in that undo's own undo row only, beside the rewound app.js (DEFERRED, header)
      A.eq(bodyOf(path.join(wt, '.env')), null, 'after the undo .env is off disk: the undo\'s own capture took it and its reset removed it');
      A.ok(!!(u && u.preRestoreId && tree(aid, u.preRestoreId).includes('.env')), 'it is in the undo\'s own undo row');
      const back = await store.restoreDetailed(aid, (u && u.preRestoreId) || '');
      A.eq(back && back.ok, true, 'restoring that row goes ahead (' + JSON.stringify(back) + ')');
      A.eq(bodyOf(path.join(wt, '.env')) + bodyOf(path.join(wt, 'app.js')), 'API_KEY=fixture-only\nv0\n', 'and brings .env back, with the rewound app.js: never lost');
    }
    {
      // a `.git` link, or a link inside a plain `.git` folder, in a folder the target lacks: the rewind deletes the files the
      // capture took there and leaves the folder, its `.git` and the link where they are (no clean; reset never enters a `.git`)
      const aid = 'v2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'neither y nor y2' });
      put(path.join(wt, 'y', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'y', '.git'));
      const outY = outside('outV2y', { 'objects/aa.bin': 'LFS-OBJECT\n', 'deep/m.txt': 'M\n' });
      link(outY, path.join(wt, 'y', '.git', 'lfs'));
      put(path.join(wt, 'y2', 'f.txt'), 'f2\n');
      const outY2 = outside('outV2y2', { 'objects/bb.bin': 'GIT-DATA\n', 'deep/m.txt': 'M2\n' });
      link(outY2, path.join(wt, 'y2', '.git'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'y and y2, their .git data linked' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['own.txt', 'y/f.txt', 'y2/f.txt'], 'fixture: both folders are walked, nothing of a `.git` is captured');
      A.eq(linkPaths(s1), [], 'and neither a `.git` link nor a link inside a `.git` is recorded');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind to a point that lacks both folders goes ahead (' + JSON.stringify(r) + ')');
      A.ok(!fs.existsSync(path.join(wt, 'y', 'f.txt')) && !fs.existsSync(path.join(wt, 'y2', 'f.txt')), 'it removes the captured files the target lacks');
      A.ok(isLink(path.join(wt, 'y', '.git', 'lfs')) && isLink(path.join(wt, 'y2', '.git')), 'and leaves y/.git/lfs and y2/.git where they are');
      A.eq(listing(outY), { 'deep/m.txt': 'M\n', 'objects/aa.bin': 'LFS-OBJECT\n' }, 'the folder behind y/.git/lfs is whole');
      A.eq(listing(outY2), { 'deep/m.txt': 'M2\n', 'objects/bb.bin': 'GIT-DATA\n' }, 'the folder behind y2/.git is whole');
    }
    {
      // Git's own data has a count of its own. The target holds x as a FILE; x is now a folder whose plain .git holds 30
      // entries, beside 19 of the person's own: with a budget of 40, one shared count (49) refused the rewind with a number
      // the person could not relate to. Past its own count the refusal names the `.git`. Within it (round 6): reset would
      // delete that `.git` with x and no capture took it, so the rewind is refused for that (round 5 let it go ahead)
      const budget = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 40 });
      const shape = async function (aid, objects) {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'own.txt'), 'own\n');
        put(path.join(wt, 'x'), 'x was a file\n');
        const s0 = await budget.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a file' });
        fs.unlinkSync(path.join(wt, 'x'));
        put(path.join(wt, 'x', 'f.txt'), 'f\n');
        for (let i = 0; i < 15; i++) put(path.join(wt, 'w' + i + '.txt'), 'w\n');
        for (let i = 0; i < objects; i++) put(path.join(wt, 'x', '.git', 'objects', 'o' + i), 'o\n');
        const s1 = await budget.snapshot(aid, { runId: 'r', turn: 2, label: 'x is a folder with Git data' });
        A.ok(s0 && s1 && s1.created, 'fixture: the walk itself (19 entries) is within the budget of 40');
        return { wt: wt, s0: s0 };
      };
      const ok = await shape('v3', 29);
      const rowsV3 = budget.list('v3').snapshots.length;
      const r = await budget.restoreDetailed('v3', ok.s0.id);
      A.eq(r && r.reason, 'uncaptured_in_path', 'a rewind whose `.git` listing (30 entries) and own files (19) are each within 40 is not refused over a count, but over the `.git` it would delete (' + JSON.stringify(r) + ')');
      A.ok(r && /"x\/\.git"/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'naming it');
      A.eq(budget.list('v3').snapshots.length, rowsV3, 'nothing was touched: no pre-restore row');
      A.ok(fs.statSync(path.join(ok.wt, 'x')).isDirectory() && fs.existsSync(path.join(ok.wt, 'x', '.git', 'objects', 'o28')), 'and x/.git is whole');
      const over = await shape('v4', 45);
      const rowsBefore = budget.list('v4').snapshots.length;
      const r2 = await budget.restoreDetailed('v4', over.s0.id);
      A.eq(r2 && r2.reason, 'link_check_failed', 'past its own count of 40 the rewind is refused (' + JSON.stringify(r2) + ')');
      A.ok(r2 && /"x\/\.git"/.test(r2.detail || '') && /more than 40 files and folders/.test(r2.detail || ''), 'naming the `.git` it was listing');
      A.eq(budget.list('v4').snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(over.wt, 'x', '.git', 'objects', 'o0')), 'and x/.git is where it was');
      // and the person's own count, on a folder the walk pruned and the check lists on demand: the target holds a FILE
      // `build`, and build/ is now an ignored folder of 45 files with no link in it
      const wt5 = path.join(ROOT, 'v5');
      put(path.join(wt5, 'build'), 'build was a file\n');
      const p0 = await budget.snapshot('v5', { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt5, 'build'));
      put(path.join(wt5, '.gitignore'), 'build/\n');
      for (let i = 0; i < 45; i++) put(path.join(wt5, 'build', 'o' + i + '.js'), 'o\n');
      const p1 = await budget.snapshot('v5', { runId: 'r', turn: 2, label: 'an ignored build/ of 45 files' });
      A.ok(p0 && p1 && p1.created, 'fixture: the walk prunes build/, so the capture is within the budget of 40');
      const rows5 = budget.list('v5').snapshots.length;
      const r3 = await budget.restoreDetailed('v5', p0.id);
      A.eq(r3 && r3.reason, 'link_check_failed', 'a rewind that would delete a pruned folder it cannot list within the count is refused, not run unchecked (' + JSON.stringify(r3) + ')');
      A.ok(r3 && /more than 40 files and folders/.test(r3.detail || ''), 'saying why');
      A.eq(budget.list('v5').snapshots.length, rows5, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(wt5, 'build', 'o44.js')), 'and build/ is whole');
    }

    // ================= 19. review round 6: a rewind never replaces or deletes what no capture took (trunk d5024f5a did, ok:true) =================
    const refusedUntouched = (store_, aid, r, rowsBefore, pathRe, label) => {
      A.eq(r && r.reason, 'uncaptured_in_path', label + ' is refused (' + JSON.stringify(r) + ')');
      A.ok(r && pathRe.test(r.detail || '') && /Nothing was changed; move it aside, then rewind again/.test(r.detail || ''), 'naming the path, and what to do');
      A.ok(r && Array.isArray(r.paths) && r.paths.length >= 1 && !r.preRestoreId, 'listing it, with no undo row');
      A.eq(store_.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
    };
    {
      // E2: s0 tracked .env (A); .env was deleted (a snapshot recorded that), then .gitignore listed .env and a new .env (B)
      // was written: no capture took B. reset wrote A over it, and B was in no row
      const aid = 'w1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, '.env'), 'KEY=A-fixture\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: '.env A tracked' });
      fs.unlinkSync(path.join(wt, '.env'));
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no .env' });
      put(path.join(wt, '.gitignore'), '.env\n');
      put(path.join(wt, '.env'), 'KEY=B-fixture\n');
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'an ignored .env B' });
      A.eq(s2 ? tree(aid, s2.id) : [], ['.gitignore', 'app.js'], 'fixture: no capture took the new .env');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"\.env" as it is now is in no restore point \(Git ignores it\), and the restore point holds a file at that path: rewinding would replace it/, 'a rewind that would write the old .env over the ignored new one');
      A.eq(bodyOf(path.join(wt, '.env')), 'KEY=B-fixture\n', 'the new .env is intact');
      A.eq(bodyOf(path.join(wt, 'app.js')), 'v1\n', 'and so is the rest of the work tree');
      fs.renameSync(path.join(wt, '.env'), path.join(wt, '.env.mine'));   // the person moves it aside: their explicit choice
      const again = await store.restoreDetailed(aid, s0.id);
      A.eq(again && again.ok, true, 'once it is moved aside, the rewind goes ahead (' + JSON.stringify(again) + ')');
      A.eq(bodyOf(path.join(wt, '.env')), 'KEY=A-fixture\n', 'writing the old .env');
      A.ok(again && again.preRestoreId && tree(aid, again.preRestoreId).includes('.env.mine'), 'and the moved one, which nothing ignores, is in the undo row (the target lacks it, so reset removed it)');
    }
    {
      // E3: the target holds a FILE `build`; build/ is now an ignored folder holding a key. reset deleted the folder with it
      const aid = 'w2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'build'), 'build was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt, 'build'));
      put(path.join(wt, '.gitignore'), 'build/\n*.key\n');
      put(path.join(wt, 'build', 'secret.key'), 'K\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'an ignored build/' });
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"build" as it is now is in no restore point \(Git ignores it\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning an ignored folder back into a file');
      A.eq(bodyOf(path.join(wt, 'build', 'secret.key')), 'K\n', 'the key is intact');
      // the same through a glob rule, deeper, in a folder the walk enters: out/deep/b.key in an out/ the target holds as a file
      const aid2 = 'w2b', wt2 = path.join(ROOT, aid2);
      put(path.join(wt2, 'out'), 'out was a file\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'out is a file' });
      fs.unlinkSync(path.join(wt2, 'out'));
      put(path.join(wt2, '.gitignore'), '*.key\n');
      put(path.join(wt2, 'out', 'a.txt'), 'a\n');
      put(path.join(wt2, 'out', 'deep', 'b.key'), 'K2\n');
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'out/ holds an ignored key' });
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"out\/deep" as it is now is in no restore point \(Git ignores it\), inside the folder "out", which the restore point holds as a file/, 'turning a folder holding an ignored file back into a file');
      A.eq(bodyOf(path.join(wt2, 'out', 'deep', 'b.key')), 'K2\n', 'that file is intact');
    }
    {
      // E4: the target holds a logs/ folder; `logs` is now an ignored FILE. reset deleted it to make the folder
      const aid = 'w3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'logs', 'a.txt'), 'a\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'a logs/ folder' });
      fs.rmSync(path.join(wt, 'logs'), { recursive: true });
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no logs' });
      put(path.join(wt, '.gitignore'), 'logs\n');
      put(path.join(wt, 'logs'), 'LOG LINES\n');
      await store.snapshot(aid, { runId: 'r', turn: 3, label: 'an ignored logs file' });
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"logs" as it is now is in no restore point \(Git ignores it\), and the restore point holds a folder at that path: rewinding would delete it/, 'a rewind that would delete an ignored file for a folder');
      A.eq(bodyOf(path.join(wt, 'logs')), 'LOG LINES\n', 'the logs file is intact');
    }
    {
      // E5: the target holds a FILE `vendor`; vendor/ is now a clone with a commit of its own and uncommitted work. reset
      // deleted it, its .git with it. And inside a clone: the target holds vendor/lib.c (a plain folder then), the clone's
      // own lib.c has an uncommitted edit, and reset wrote the old one over it
      const aid = 'w4', wt = path.join(ROOT, aid), v = path.join(wt, 'vendor');
      put(path.join(wt, 'app.js'), 'v0\n');
      put(v, 'vendor was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'vendor is a file' });
      fs.unlinkSync(v);
      put(path.join(v, 'lib.c'), 'int x;\n');
      gitInit(v);
      put(path.join(v, 'wip.c'), 'uncommitted\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'vendor is a clone' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['app.js', 'vendor'], 'fixture: the clone is one gitlink');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"vendor" as it is now is in no restore point \(it is an embedded Git repository\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning a clone back into a file');
      A.ok(fs.existsSync(path.join(v, '.git', 'HEAD')) && bodyOf(path.join(v, 'wip.c')) === 'uncommitted\n', 'the clone, its history and its uncommitted work are intact');
      const aid2 = 'w4b', wt2 = path.join(ROOT, aid2), v2 = path.join(wt2, 'vendor');
      put(path.join(v2, 'lib.c'), 'old\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'vendor is a plain folder' });
      fs.rmSync(v2, { recursive: true });
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'no vendor' });
      put(path.join(v2, 'lib.c'), 'committed\n');
      gitInit(v2);
      put(path.join(v2, 'lib.c'), 'uncommitted edit\n');
      await store.snapshot(aid2, { runId: 'r', turn: 3, label: 'vendor is a clone' });
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"vendor\/lib\.c" as it is now is in no restore point \(it is inside the embedded repository "vendor"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one inside a clone');
      A.eq(bodyOf(path.join(v2, 'lib.c')), 'uncommitted edit\n', 'the clone\'s uncommitted edit is intact');
      // a clone the shadow index records as a gitlink whose .git went away: Git still reads nothing below that gitlink,
      // so no capture takes the files there either
      const aid3 = 'w4c', wt3 = path.join(ROOT, aid3), v3 = path.join(wt3, 'vendor');
      put(v3, 'vendor was a file\n');
      const u0 = await store.snapshot(aid3, { runId: 'r', turn: 1, label: 'vendor is a file' });
      fs.unlinkSync(v3);
      put(path.join(v3, 'lib.c'), 'c\n');
      gitInit(v3);
      await store.snapshot(aid3, { runId: 'r', turn: 2, label: 'vendor is a clone' });
      fs.rmSync(path.join(v3, '.git'), { recursive: true, force: true });
      put(path.join(v3, 'notes.txt'), 'work no capture took\n');
      const rows3 = store.list(aid3).snapshots.length;
      refusedUntouched(store, aid3, await store.restoreDetailed(aid3, u0.id), rows3, /^"vendor" as it is now is in no restore point \(it is an embedded Git repository\)/, 'turning a recorded gitlink\'s folder back into a file');
      A.eq(bodyOf(path.join(v3, 'notes.txt')), 'work no capture took\n', 'the files below it are intact');
      // the control: the target holds vendor as a gitlink itself, so Git leaves the clone where it stands
      const aid4 = 'w4d', wt4 = path.join(ROOT, aid4), v4 = path.join(wt4, 'vendor');
      put(path.join(wt4, 'app.js'), 'v0\n');
      put(path.join(v4, 'lib.c'), 'c\n');
      gitInit(v4);
      const g0 = await store.snapshot(aid4, { runId: 'r', turn: 1, label: 'vendor is a gitlink' });
      put(path.join(wt4, 'app.js'), 'v1\n');
      put(path.join(v4, 'wip.c'), 'w\n');
      await store.snapshot(aid4, { runId: 'r', turn: 2, label: 'later' });
      const rg = await store.restoreDetailed(aid4, g0.id);
      A.eq(rg && rg.ok, true, 'a rewind to a point that holds the clone as a gitlink goes ahead (' + JSON.stringify(rg) + ')');
      A.eq(bodyOf(path.join(wt4, 'app.js')) + bodyOf(path.join(v4, 'wip.c')), 'v0\nw\n', 'and leaves the clone\'s work where it is');
    }
    {
      // the controls: what a capture takes is no reason to refuse, and what stands at no path the target holds stays
      const aid = 'w5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'out'), 'out was a file\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'kept\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'out is a file' });
      fs.unlinkSync(path.join(wt, 'out'));
      put(path.join(wt, 'out', 'a.txt'), 'a\n');
      fs.mkdirSync(path.join(wt, 'out', 'empty'));
      put(path.join(wt, '.gitignore'), 'dist/\n.env\n');
      put(path.join(wt, 'dist', 'bundle.js'), 'built, ignored\n');
      put(path.join(wt, '.env'), 'KEY=fixture\n');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a folder holding only captured files turns back into a file, beside ignored files at no path the target holds (' + JSON.stringify(r) + ')');
      A.eq(bodyOf(path.join(wt, 'out')), 'out was a file\n', 'and rewinds');
      A.ok(r && r.preRestoreId && tree(aid, r.preRestoreId).includes('out/a.txt'), 'out/a.txt is in the undo row');
      A.eq(bodyOf(path.join(wt, 'dist', 'bundle.js')) + bodyOf(path.join(wt, '.env')), 'built, ignored\nKEY=fixture\n', 'the ignored files stay where they are');
      A.eq(bodyOf(path.join(wt, 'dist', 'keep.txt')), 'kept\n', 'beside the tracked file in the ignored folder');
    }
    {
      // review 6.2: Git's own repository rule is broader than the walk's looksLikeRepo. A LINKED WORKTREE (its .git a gitfile
      // naming <main>/.git/worktrees/<name>, which holds a commondir) and a folder whose `.git` is a LINK to a repository are
      // embedded repositories to Git (is_nonbare_repository_dir): `add -A` records one gitlink and takes none of their files.
      // Neither was counted, so reset wrote the target's file over a worktree's uncommitted edit, deleted a worktree's
      // folder for a target FILE, and overwrote an edit beside a `.git` link, each ok:true with the edit in no row
      const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
      const main = outside('mainW6', { 'main.c': 'committed in main\n' });
      gitInit(main);
      const worktreeAt = (dir) => execFileSync('git', ident.concat(['worktree', 'add', '-q', '--detach', dir]), { cwd: main, stdio: 'ignore' });
      const aid = 'w6', wt = path.join(ROOT, aid), feat = path.join(wt, 'feat');
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(feat, 'main.c'), 'old plain folder\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'feat is a plain folder' });
      fs.rmSync(feat, { recursive: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no feat' });
      worktreeAt(feat);
      put(path.join(feat, 'main.c'), 'UNCOMMITTED WORKTREE EDIT\n');
      A.ok(/^gitdir: /.test(bodyOf(path.join(feat, '.git')) || ''), 'fixture: feat is a linked worktree, no capture since');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"feat\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "feat"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one inside a linked worktree');
      A.eq(bodyOf(path.join(feat, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED WORKTREE EDIT\nv1\n', 'the worktree\'s uncommitted edit is intact');
      // the target holds a FILE feat/sub; feat/ is now a linked worktree whose sub/ holds the person's notes
      const aid2 = 'w6b', wt2 = path.join(ROOT, aid2), feat2 = path.join(wt2, 'feat');
      put(path.join(feat2, 'sub'), 'sub was a file\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'feat/sub is a file' });
      fs.rmSync(feat2, { recursive: true });
      put(path.join(wt2, 'app.js'), 'v1\n');
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'no feat' });
      worktreeAt(feat2);
      put(path.join(feat2, 'sub', 'notes.md'), 'WORKTREE NOTES\n');
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"feat\/sub" as it is now is in no restore point \(it is inside the embedded repository "feat"\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning a folder inside a linked worktree back into a file');
      A.eq(bodyOf(path.join(feat2, 'sub', 'notes.md')), 'WORKTREE NOTES\n', 'the notes in it are intact');
      // lib/.git is a link to a repository's git-dir (a fixture folder): an edited lib/file.txt no capture took
      const repo = outside('repoW6', { 'file.txt': 'committed\n' });
      gitInit(repo);
      const aid3 = 'w6c', wt3 = path.join(ROOT, aid3), lib = path.join(wt3, 'lib');
      put(path.join(wt3, 'app.js'), 'v0\n');
      put(path.join(lib, 'file.txt'), 'old\n');
      const u0 = await store.snapshot(aid3, { runId: 'r', turn: 1, label: 'lib is a plain folder' });
      fs.rmSync(lib, { recursive: true });
      await store.snapshot(aid3, { runId: 'r', turn: 2, label: 'no lib' });
      put(path.join(lib, 'file.txt'), 'UNCOMMITTED EDIT\n');
      link(path.join(repo, '.git'), path.join(lib, '.git'));
      const rows3 = store.list(aid3).snapshots.length;
      refusedUntouched(store, aid3, await store.restoreDetailed(aid3, u0.id), rows3, /^"lib\/file\.txt" as it is now is in no restore point \(it is inside the embedded repository "lib"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one beside a `.git` link');
      A.eq(bodyOf(path.join(lib, 'file.txt')), 'UNCOMMITTED EDIT\n', 'the edit is intact');
      A.ok(isLink(path.join(lib, '.git')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'and so are the link and the repository behind it');
      // the control: a folder holding a `.git` that the shadow index tracks a path below is a plain folder to Git, which
      // captures its files, so the rewind goes ahead and the file it writes over is in the undo row
      const aid4 = 'w6d', wt4 = path.join(ROOT, aid4), lib4 = path.join(wt4, 'lib');
      put(path.join(lib4, 'keep.txt'), 'kept\n');
      put(path.join(lib4, 'old.txt'), 'old\n');
      const g0 = await store.snapshot(aid4, { runId: 'r', turn: 1, label: 'lib holds keep and old' });
      fs.unlinkSync(path.join(lib4, 'old.txt'));
      await store.snapshot(aid4, { runId: 'r', turn: 2, label: 'old.txt deleted' });
      put(path.join(lib4, 'old.txt'), 'NEWER, no capture yet\n');
      link(path.join(repo, '.git'), path.join(lib4, '.git'));
      const rc = await store.restoreDetailed(aid4, g0.id);
      A.eq(rc && rc.ok, true, 'a rewind into a captured folder that now holds a `.git` goes ahead (' + JSON.stringify(rc) + ')');
      A.eq(bodyOf(path.join(lib4, 'old.txt')), 'old\n', 'writing the target\'s file');
      const undone = rc && rc.preRestoreId ? execFileSync('git', ['--git-dir', gitDirOf(aid4), 'show', rc.preRestoreId + ':lib/old.txt'], { encoding: 'utf8' }) : null;
      A.eq(undone, 'NEWER, no capture yet\n', 'and the newer one is in the undo row (Git captured it: lib is a plain folder to it)');
      A.ok(isLink(path.join(lib4, '.git')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'the `.git` link and the repository behind it stay where they were');
    }
    {
      // w7, macOS: the file system folds case as NTFS does, and Git (core.ignorecase) reads a `.GIT` there as the `.git` of
      // an embedded repository, but the store's classifier folds that name on Windows only. Emulated on NTFS: a store
      // whose paths use '/' as the separator, made while process.platform says darwin. Reset wrote the target's file
      // over an uncommitted edit in a clone whose git-dir is spelled .GIT, ok:true, the edit in no row
      if (isWin || process.platform === 'darwin') {
        let mac = null;
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        if (isWin) Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        try { mac = makeCheckpointStore({ fs, pathMod: isWin ? Object.assign(Object.create(path), { sep: '/' }) : path, root: ROOT, runGit, clock, keep: 50 }); }
        finally { if (isWin) Object.defineProperty(process, 'platform', platform); }
        const aid = 'w7', wt = path.join(ROOT, aid), x = path.join(wt, 'x');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(x, 'main.c'), 'old plain folder\n');
        const s0 = await mac.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a plain folder' });
        fs.rmSync(x, { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await mac.snapshot(aid, { runId: 'r', turn: 2, label: 'no x' });
        put(path.join(x, 'main.c'), 'committed\n');
        gitInit(x);
        fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT'));
        put(path.join(x, 'main.c'), 'UNCOMMITTED EDIT\n');
        A.ok(fs.readdirSync(x).includes('.GIT'), 'fixture: x is a clone whose git-dir is spelled .GIT, no capture since');
        const rows = mac.list(aid).snapshots.length;
        refusedUntouched(mac, aid, await mac.restoreDetailed(aid, s0.id), rows, /^"x\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "x"\), and the restore point holds a file at that path: rewinding would replace it/, 'on macOS, writing a file over one inside a clone whose `.git` is spelled `.GIT`');
        A.eq(bodyOf(path.join(x, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED EDIT\nv1\n', 'the clone\'s uncommitted edit is intact');
      } else console.log('[skip] macOS `.GIT`: a case-sensitive file system reads it as a plain folder, as Git does here');
    }
    {
      // review minors: the rest of a `.GIT`, emulated on NTFS as w7 is (a store whose paths use '/' as the separator, made
      // while process.platform says darwin or linux)
      const storeAs = (platform) => {
        const was = Object.getOwnPropertyDescriptor(process, 'platform'), other = process.platform !== platform;
        if (other) Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        try { return makeCheckpointStore({ fs, pathMod: isWin ? Object.assign(Object.create(path), { sep: '/' }) : path, root: ROOT, runGit, clock, keep: 50 }); }
        finally { if (other) Object.defineProperty(process, 'platform', was); }
      };
      if (isWin || process.platform === 'darwin') {
        // w7b, macOS: a `.GIT` in a folder the shadow index tracks files below is no repository to Git, which skips it as it
        // skips a `.git` (core.ignorecase), so no capture takes it, and only the walk's gitFolders (a folder) and gitFiles
        // (a file) name it. The target holds a FILE d; d/ now holds a captured kept.txt beside a plain .GIT folder, then
        // beside a .GIT file that is no gitfile. No row reached those two lists: without them reset deleted d with its .GIT,
        // ok:true, the .GIT in no row
        const mac = storeAs('darwin');
        for (const [aid, at, body, what] of [['w7b', ['.GIT', 'notes.txt'], 'NOTES, in no capture\n', 'a plain `.GIT` folder'],
          ['w7c', ['.GIT'], 'not a gitfile\n', 'a `.GIT` file that is no gitfile']]) {
          const wt = path.join(ROOT, aid), d = path.join(wt, 'd');
          put(path.join(wt, 'app.js'), 'v0\n');
          put(d, 'd was a file\n');
          const s0 = await mac.snapshot(aid, { runId: 'r', turn: 1, label: 'd is a file' });
          fs.unlinkSync(d);
          put(path.join(d, 'kept.txt'), 'kept\n');
          put(path.join(d, ...at), body);
          const s1 = await mac.snapshot(aid, { runId: 'r', turn: 2, label: 'd is a folder' });
          const held = s1 && s1.created ? tree(aid, s1.id) : [];
          A.ok(held.includes('d/kept.txt') && !held.some((p) => /^d\/\.git(\/|$)/i.test(p)), 'fixture: the capture took d/kept.txt, and Git skipped d/.GIT (' + what + ')');
          const rows = mac.list(aid).snapshots.length;
          refusedUntouched(mac, aid, await mac.restoreDetailed(aid, s0.id), rows, /^"d\/\.GIT" as it is now is in no restore point \(it is Git's own data\), inside the folder "d", which the restore point holds as a file: rewinding would delete that folder with it/, 'on macOS, turning a folder that holds ' + what + ' back into a file');
          A.eq(bodyOf(path.join(d, ...at)) + bodyOf(path.join(d, 'kept.txt')), body + 'kept\n', 'd/.GIT and d/kept.txt are intact');
        }
        // w7d-w7f, Linux on a case-insensitive mount (WSL's /mnt/c, ext4 casefold, vfat/exFAT): Git asks the file system for
        // x/.git (is_nonbare_repository_dir), so a clone whose git-dir is spelled .GIT, a linked worktree whose gitfile is,
        // and a `.GIT` link to a repository are each one gitlink to `add -A`, whatever core.ignorecase says. The walk
        // counted a `.GIT` on macOS only, so reset wrote the target's x/main.c over the uncommitted edit, ok:true, the
        // edit in no row (fd7ee0f0 and trunk d5024f5a did the same)
        const lin = storeAs('linux');
        const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
        const main = outside('mainW7', { 'main.c': 'committed in main\n' });
        gitInit(main);
        const repo = outside('repoW7', { 'main.c': 'committed\n' });
        gitInit(repo);
        const shapes = [
          ['w7d', 'a clone whose git-dir is spelled .GIT', (x) => { put(path.join(x, 'main.c'), 'committed\n'); gitInit(x); fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT')); }],
          ['w7e', 'a linked worktree whose gitfile is spelled .GIT', (x) => {
            execFileSync('git', ident.concat(['worktree', 'add', '-q', '--detach', x]), { cwd: main, stdio: 'ignore' });
            fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT'));
          }],
          ['w7f', 'a folder whose `.GIT` is a link to a repository', (x) => { fs.mkdirSync(x, { recursive: true }); link(path.join(repo, '.git'), path.join(x, '.GIT')); }],
        ];
        for (const [aid, what, make] of shapes) {
          const wt = path.join(ROOT, aid), x = path.join(wt, 'x');
          put(path.join(wt, 'app.js'), 'v0\n');
          put(path.join(x, 'main.c'), 'old plain folder\n');
          const s0 = await lin.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a plain folder' });
          fs.rmSync(x, { recursive: true });
          put(path.join(wt, 'app.js'), 'v1\n');
          await lin.snapshot(aid, { runId: 'r', turn: 2, label: 'no x' });
          make(x);
          put(path.join(x, 'main.c'), 'UNCOMMITTED EDIT\n');
          A.ok(fs.readdirSync(x).includes('.GIT') && !fs.readdirSync(x).includes('.git'), 'fixture: x is ' + what + ', no capture since');
          const rows = lin.list(aid).snapshots.length;
          refusedUntouched(lin, aid, await lin.restoreDetailed(aid, s0.id), rows, /^"x\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "x"\), and the restore point holds a file at that path: rewinding would replace it/, 'on Linux over a case-insensitive mount, writing a file over one inside ' + what);
          A.eq(bodyOf(path.join(x, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED EDIT\nv1\n', 'the uncommitted edit is intact');
        }
        A.ok(isLink(path.join(ROOT, 'w7f', 'x', '.GIT')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'the `.GIT` link and the repository behind it stay where they were');
      } else console.log('[skip] `.GIT` on macOS and on a case-insensitive Linux mount: this file system is case-sensitive, and Git refuses to add a `.GIT` path here');
    }

    // ================= 20. final review 2: a completed rewind's undo row restores through restoreDetailed =================
    {
      // fr1: T0 holds package.json only. Then a .gitignore lists node_modules, 120 files no capture takes go in there, and
      // S1 captures app.js v1; the person edits app.js. The rewind to T0 deletes .gitignore and app.js and keeps
      // node_modules (no capture took it), which nothing prunes now. Its undo walked node_modules by the work tree's
      // rules alone: past the walk's budget (60 here; 250000 files and folders, 10 s by default) it was refused
      // (link_check_failed), .gitignore and app.js v2 in the shadow repo only (trunk d5024f5a's clean had deleted
      // node_modules for good, and its undo ran); within the budget its capture took the whole folder (one add -A under the
      // runner's 15 s per call) and its reset deleted it. A rewind's walk now prunes by the target's own .gitignore too, and
      // its capture leaves out what only that prunes
      const budget = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 60 });
      const aid = 'fr1', wt = path.join(ROOT, aid), nm = path.join(wt, 'node_modules');
      put(path.join(wt, 'package.json'), '{"v":0}\n');
      const t0 = await budget.snapshot(aid, { runId: 'r', turn: 1, label: 'package.json only' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      for (let i = 0; i < 120; i++) put(path.join(nm, 'pkg' + (i % 8), 'lib', 'file_' + i + '.js'), 'x' + i + '\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await budget.snapshot(aid, { runId: 'r', turn: 2, label: '.gitignore and app.js' });
      A.eq(t0 && s1 && s1.created ? tree(aid, s1.id) : [], ['.gitignore', 'app.js', 'package.json'], 'fixture: the walk prunes node_modules (budget 60), and no capture took it');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      const before = listing(wt);
      A.eq(Object.keys(before).length, 123, 'fixture: package.json, .gitignore, app.js and the 120 files');
      const r = await budget.restoreDetailed(aid, t0.id);
      A.eq(r && r.ok, true, 'the rewind to before the .gitignore goes ahead (' + JSON.stringify(r) + ')');
      const after = listing(wt);
      A.ok(!('.gitignore' in after) && !('app.js' in after) && Object.keys(after).length === 121, 'it removes .gitignore and app.js and keeps the 120 files no capture took');
      const u = await budget.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead within the walk\'s budget (' + JSON.stringify(u) + ')');
      A.eq(listing(wt), before, 'and every path and byte is back: .gitignore, app.js v2, package.json and the 120 files where they were');
      A.ok(!!(u && u.preRestoreId) && !tree(aid, u.preRestoreId).some((p) => /^node_modules\//.test(p)), 'the undo\'s own capture left node_modules out (the undo row ignores it), so its reset never deleted it');
      const again = await budget.restoreDetailed(aid, s1.id);
      A.eq([again && again.ok, bodyOf(path.join(wt, 'app.js')), fs.existsSync(path.join(nm, 'pkg7', 'lib', 'file_119.js'))], [true, 'v1\n', true],
        'and the row it was rewound from restores too, node_modules where it was');
    }
    {
      // fr2, the control: a folder only the target's .gitignore lists, which the target still tracks a file in (captured
      // before its rule). Now no rule lists dist, and dist holds a new keep.txt where the target holds one and a new
      // out.js, neither captured yet. dist is kept out of the capture like any folder only the target's rules prune (undo
      // closure: walked and captured whole, as before, its undo took what a rule had kept out of the rewind and deleted
      // it, fr4), but the capture takes the new keep.txt BY NAME, as the target writes over it (kept out with no more,
      // the new keep.txt was in no restore point, and the rewind refused), and leaves out.js where it is, as the rewound
      // .gitignore ignores it; reset writes the target's keep.txt, and the undo brings the new one back
      const aid = 'fr2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'the target\'s keep.txt\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'dist/keep.txt captured' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'dist ignored, keep.txt still tracked' });
      A.ok(t0 && t0.created && tree(aid, t0.id).includes('dist/keep.txt'), 'fixture: the target ignores dist and tracks dist/keep.txt');
      fs.unlinkSync(path.join(wt, 'dist', 'keep.txt'));
      put(path.join(wt, '.gitignore'), '*.log\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'no dist rule, no keep.txt' });
      A.ok(s1 && s1.created && !tree(aid, s1.id).includes('dist/keep.txt'), 'fixture: keep.txt is gone from the index');
      put(path.join(wt, 'dist', 'keep.txt'), 'NEWER keep.txt, no capture yet\n');
      put(path.join(wt, 'dist', 'out.js'), 'built, no capture yet\n');
      const before = listing(wt);
      const r = await store.restoreDetailed(aid, t0.id);
      A.eq(r && r.ok, true, 'the rewind goes ahead (' + JSON.stringify(r) + ')');
      A.eq([bodyOf(path.join(wt, 'dist', 'keep.txt')), bodyOf(path.join(wt, 'dist', 'out.js'))], ['the target\'s keep.txt\n', 'built, no capture yet\n'], 'writing the target\'s keep.txt and keeping out.js where it is');
      const held = r && r.preRestoreId ? tree(aid, r.preRestoreId) : [];
      A.ok(held.includes('dist/keep.txt') && !held.includes('dist/out.js'), 'the new keep.txt in the undo row, taken by name; out.js left out, as a capture of the rewound tree leaves it out too');
      const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(u) + ')');
      A.eq(listing(wt), before, 'and every path and byte is back: the newer keep.txt and out.js');
    }
    // ---- undo closure (r3 review, Codex A4-2D1-01/02): every completed rewind's preRestoreId restores through
    // restoreDetailed, every path and byte (twoCalls), or the rewind is refused with no file touched and no row (refusedClean) ----
    const twoCalls = async (st, aid, wt, targetId, label) => {
      const before = listing(wt);
      const r = await st.restoreDetailed(aid, targetId);
      A.eq(r && r.ok, true, label + ': the rewind goes ahead (' + JSON.stringify(r) + ')');
      const mid = listing(wt);
      const u = await st.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, label + ': restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(u) + ')');
      A.eq(listing(wt), before, label + ': and every path and byte is back');
      return { r: r, mid: mid, u: u, before: before };
    };
    const refusedClean = async (st, aid, wt, targetId, reason, detailRe, label) => {
      const before = listing(wt), rows = st.list(aid).snapshots.length;
      const r = await st.restoreDetailed(aid, targetId);
      A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId)], [false, reason, false], label + ' is refused, with no undo row (' + JSON.stringify(r) + ')');
      A.ok(detailRe.test((r && r.detail) || ''), label + ': saying why (' + JSON.stringify(r && r.detail) + ')');
      A.eq([st.list(aid).snapshots.length, listing(wt)], [rows, before], label + ': no row added, every path and byte in the workspace as it was');
    };
    const flatName = (i) => 'sample_' + String(i).padStart(4, '0') + '_with_a_long_descriptive_name.bin';
    // the real runner, its output limit 1500 bytes: 20 of these names fit in one folder's own entry list, 40 do not
    const capped = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50,
      runGit: makeCheckpointGitRunner({ spawn, maxBytes: 1500, clock: { now: () => Date.now() } }) });
    {
      // fr3 (r3 BLOCKER): T's .gitignore lists vendor, which T still tracks (20 flat names, captured before the rule); now
      // the rule is gone and vendor/blobs holds 40, all captured, then app.js v3 and a new notes.txt no capture took. The
      // rewind WALKED vendor (the target held paths there) and completed; its undo pruned it by the rewound .gitignore and
      // listed it whole: past the limit, refused (link_check_failed), 20 blobs and notes.txt in the shadow repo only. Now
      // every folder only the target's rules prune is pruned on the rewind too, so the rewind lists it and is refused
      const aid = 'fr3', wt = path.join(ROOT, aid), flat = path.join(wt, 'vendor', 'blobs');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 20; i++) put(path.join(flat, flatName(i)), 'b' + i + '\n');
      await capped.snapshot(aid, { runId: 'r', turn: 0, label: 'vendor/blobs 20' });
      put(path.join(wt, '.gitignore'), 'vendor\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const t = await capped.snapshot(aid, { runId: 'r', turn: 1, label: 'vendor ignored, still tracked' });
      put(path.join(wt, '.gitignore'), 'other\n');
      for (let i = 20; i < 40; i++) put(path.join(flat, flatName(i)), 'b' + i + '\n');
      put(path.join(wt, 'app.js'), 'v2\n');
      const c1 = await capped.snapshot(aid, { runId: 'r', turn: 2, label: 'no vendor rule, 40 blobs' });
      A.eq([t && t.files, c1 && c1.files], [22, 42], 'fixture: T tracks 20 blobs below its vendor rule, C1 40 with no rule');
      put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
      put(path.join(wt, 'notes.txt'), 'new, no snapshot took this\n');
      await refusedClean(capped, aid, wt, t.id, 'link_check_failed', /could not be listed to check them for links/, 'fr3, a rewind whose undo would have to list a flat folder past the limit');
    }
    {
      // fr3b (Codex A4-2D1-01): the same through an ordinary RECORDED target no capture under this limit makes: T0 tracks a
      // flat data/ of 60 long names below its own `data` rule (recorded by this file's runner, which has no such limit, as
      // an older store or a bigger limit records it); S1 has the same
      // files, an empty .gitignore and app.js v1; app.js v2 since. The rewind changed only .gitignore and app.js and
      // completed; its undo pruned data and could not list it (link_check_failed). Refused now, before anything is touched
      const aid = 'fr3b', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 60; i++) put(path.join(wt, 'data', flatName(i)), 'd' + i + '\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'data tracked' });
      put(path.join(wt, '.gitignore'), 'data\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T0: data ignored, still tracked' });
      put(path.join(wt, '.gitignore'), '');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no rule' });
      A.eq([t0 && t0.files, s1 && s1.created && s1.files], [62, 62], 'fixture: T0 and S1 hold the same 60 data files');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(capped, aid, wt, t0.id, 'link_check_failed', /could not be listed to check them for links/, 'fr3b, a rewind to a recorded target holding an ignored flat folder past the limit');
    }
    {
      // fr3c: what the undo lists below vendor is its index (the target) and its row (the tree this capture stages):
      // T tracks 20 b-names, the index 20 a-names, and the capture takes 20 new b-files by name, so each tree the rewind
      // lists holds 20 names and the staged one 40. Listed with that tree staged, before its commit, the rewind is
      // refused untouched; listed by the rewind's own trees alone, it completed and its undo was refused
      const aid = 'fr3c', wt = path.join(ROOT, aid), flat = path.join(wt, 'vendor', 'blobs');
      put(path.join(wt, 'app.js'), 'v0\n');
      for (let i = 0; i < 20; i++) put(path.join(flat, 'b' + flatName(i)), 'b' + i + '\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'b tracked' });
      put(path.join(wt, '.gitignore'), 'vendor\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: vendor ignored, b tracked' });
      fs.rmSync(path.join(wt, 'vendor'), { recursive: true });
      put(path.join(wt, '.gitignore'), 'other\n');
      for (let i = 0; i < 20; i++) put(path.join(flat, 'a' + flatName(i)), 'a' + i + '\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: a tracked' });
      A.eq([t && t.files, s1 && s1.created && s1.files], [22, 22], 'fixture: T holds 20 b-files, S1 20 a-files');
      for (let i = 0; i < 20; i++) put(path.join(flat, 'b' + flatName(i)), 'NEW b' + i + '\n');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await refusedClean(capped, aid, wt, t.id, 'link_check_failed', /^the files its undo would bring back could not be listed/, 'fr3c, a rewind whose staged tree and target together pass the limit');
    }
    {
      // fr4 (r3 MAJOR): S1 tracks 16 node_modules files and no rule lists the folder; S2's .gitignore lists it, 40 extras
      // went in since, no capture takes them; app.js v2 since. The rewind to S1 prunes node_modules by the work tree's
      // rule and keeps the extras. Its undo walked node_modules (the undo row's .gitignore listed it, but the row tracked
      // files there): past a 60-entry budget refused (link_check_failed), within the default its capture took the 40
      // extras and its reset deleted them, in that second undo row only. Kept out now, so they stay, both ways
      for (const [aid, budgetMax] of [['fr4', 60], ['fr4b', 0]]) {
        const st = budgetMax ? makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: budgetMax }) : store;
        const wt = path.join(ROOT, aid), nm = path.join(wt, 'node_modules');
        put(path.join(wt, '.gitignore'), '*.log\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 16; i++) put(path.join(nm, 'pkg' + (i % 8), 'lib', 'file_' + i + '.js'), 'x' + i + '\n');
        const s1 = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'S1: node_modules captured, no rule' });
        put(path.join(wt, '.gitignore'), 'node_modules\n*.log\n');
        for (let i = 0; i < 40; i++) put(path.join(nm, 'extra', 'e_' + i + '.js'), 'e' + i + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s2 = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S2: node_modules ignored, 40 extras' });
        A.eq([s1 && s1.files, s2 && s2.created && s2.files], [18, 18], 'fixture (' + aid + '): both rows track the 16 files, neither an extra');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid, u } = await twoCalls(st, aid, wt, s1.id, aid + (budgetMax ? ' (budget ' + budgetMax + ')' : ' (default budget)'));
        A.eq(Object.keys(mid).filter((k) => /^node_modules\/extra\//.test(k)).length, 40, aid + ': the rewind kept the 40 extras where they were');
        A.ok(!!(u && u.preRestoreId) && !tree(aid, u.preRestoreId).some((p) => /^node_modules\/extra\//.test(p)), aid + ': the undo\'s capture left them out too (its row\'s .gitignore lists node_modules)');
      }
    }
    {
      // fr5 (Codex A4-2D1-02): a rewind across 33 changed .gitignore files (the root's lists node_modules, 32 small
      // folders have one each), 150 node_modules files no capture took, budget 120. Past 32 the rewind's walk dropped the
      // target's rules, so the undo walked node_modules by the work tree's rules alone and was refused (link_check_failed).
      // Every changed .gitignore is read now
      const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 120 });
      const aid = 'fr5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      const t0 = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'package.json only' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      for (let i = 0; i < 32; i++) put(path.join(wt, 'd' + i, '.gitignore'), '*.tmp\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      for (let i = 0; i < 150; i++) put(path.join(wt, 'node_modules', 'pkg' + (i % 8), 'lib', 'f' + i + '.js'), 'x' + i + '\n');
      const s1 = await st.snapshot(aid, { runId: 'r', turn: 1, label: '33 .gitignore files' });
      A.eq(s1 && s1.created && s1.files, 35, 'fixture: 33 .gitignore files, package.json and app.js captured, no node_modules file');
      put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
      await twoCalls(st, aid, wt, t0.id, 'fr5, a rewind across 33 changed .gitignore files');
      // and when Git cannot read them, the rewind is refused before anything is touched (it walked by the work tree's
      // rules alone and went ahead)
      const noGrep = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, scanMaxEntries: 120,
        runGit: async (args, opts) => (args.indexOf('grep') >= 0 ? { code: 128, stdout: '', stderr: 'fatal: failed on purpose' } : runGit(args, opts)) });
      await refusedClean(noGrep, aid, wt, t0.id, 'link_check_failed', /^the \.gitignore files of the restore point could not be read/, 'fr5, a rewind whose target .gitignore files Git cannot read');
    }
    if (isWin || process.platform === 'darwin') {
      // fr6 (r3 minor): the target tracks Node_Modules/foo below its node_modules rule; the folder on disk is spelled
      // node_modules and holds the person's foo no capture took. Where the file system folds case, the target holds that
      // path; a case-sensitive lookup said it held nothing there, kept the folder out of the capture, and refused the
      // rewind ('uncaptured_in_path'). Its foo is taken by name now, and the undo brings it back
      const aid = 'fr6', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'Node_Modules', 'foo'), 'target foo\n');
      await store.snapshot(aid, { runId: 'r', turn: 0, label: 'Node_Modules/foo' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'rule, Node_Modules/foo still tracked' });
      fs.rmSync(path.join(wt, 'Node_Modules'), { recursive: true });
      fs.unlinkSync(path.join(wt, '.gitignore'));
      put(path.join(wt, 'app.js'), 'v2\n');
      const s3 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no folder, no rule' });
      A.ok(!!(t && t.created && s3 && s3.created) && tree(aid, t.id).includes('Node_Modules/foo'), 'fixture: the target spells it Node_Modules/foo');
      put(path.join(wt, 'node_modules', 'foo'), 'PERSON foo, no capture took this\n');
      const { mid } = await twoCalls(store, aid, wt, t.id, 'fr6, a rewind where only the case of a folder differs');
      A.eq(Object.keys(mid).filter((k) => /^node_modules\/foo$/i.test(k)).map((k) => mid[k]), ['target foo\n'], 'fr6: the rewind wrote the target\'s foo (in whichever case it spells the folder)');
    } else console.log('[skip] fr6: this file system does not fold case');
    {
      // this file runs 66-79 s on a quiet box and 308-477 s with the CPU held at 100% (slow.list says when), past
      // test/slow.list's 40 s rule; listed there, a gate gives it 600 s, not 120 s
      const slow = fs.readFileSync(path.join(__dirname, 'slow.list'), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(slow.includes('test/checkpoint-links.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
    }
    {
      const route = sidecarTopLevelFunction('handleCheckpointRestore');
      A.ok(/out\.reason === 'uncaptured_in_path' \|\| out\.reason === 'uncaptured_check_failed'\)\) return json\(409, \{ error: 'restore refused: ' \+ String\(out\.detail/.test(route),
        'the restore route answers the refusal 409 in the store\'s own words (it would have fallen through to "no such snapshot")');
      A.ok(/out\.reason === 'git_failed'\) return json\(500, \{ error: 'restore did not complete' \+ \(out\.detail \? ' \(' \+ out\.detail \+ '\)' : ''\)/.test(route),
        'and an incomplete rewind names what it could not remove');
    }
  } finally {
    for (const l of links.slice().reverse()) {
      let present = true;
      try { fs.lstatSync(l); } catch (_) { present = false; }
      if (!present) { links.splice(links.indexOf(l), 1); continue; }   // a link a failing rewind removed: nothing left to unlink
      try { unlinkLink(l); } catch (e) { console.log('[cleanup] could not remove link ' + l + ': ' + e.message); }
    }
    if (!links.length) { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {} }
    else console.log('[cleanup] left ' + BASE + ' in place: links remain');
  }
  A.report('checkpoint-links.test');
})().catch((e) => { console.log('FAIL: checkpoint-links.test threw — ' + (e && e.stack || e)); process.exit(1); });
