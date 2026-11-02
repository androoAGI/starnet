/* node test/checkpoint-undo-reads.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where Git's reading of the work tree, of the
   bytes or of the person's config was not the checks' own (lane checkpoint-links, undo reviews 7-9, 2026-11-01/02;
   sidecar/checkpoint-store.js, the header's THE PROMISE and restore's THE UNDO ROW RESTORES THROUGH THIS API). The rows of
   undo reviews 1-3 are test/checkpoint-undo.test.js and those of undo reviews 4-6 test/checkpoint-undo-gitlinks.test.js;
   these were split from the latter at undo review 9, rows, oracles and counts unchanged, so each step keeps its room under
   test/slow.list's 600 s.

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
   Undo review 8 found, at 2caa2665, each with both calls ok:true unless it says otherwise (each block below says more):
     uw3-uw5 ud3 ud5 ur3s ur3x us2 us4 uu3 sg3-sg7 ovk ova ovg uafs  the walk's fold was not the file system's. A capital sigma at a name's end read as
           final sigma, NTFS reads it as small sigma: the review 7 family again, and a junction's target emptied (ab10c33a and trunk d5024f5a
           the same). A name it read as one with another NTFS keeps apart (the Kelvin sign and k): T's FILE emptied a junction's target beside
           them. Sigma has one form in the fold now, and two entries of one folder it reads as one are refused;
     ovkb-ovke ovt ovkf ovkk  and, found in that repair's first refusal: a rewind that makes such a pair for its undo to meet. T's k with the undo row's Kelvin twin went ahead and its
           undo was refused on every try, its row holding the person's only copy (2caa2665 the same); a name with the Kelvin sign is refused now, in a tree or a folder the checks list;
     kl1 kl1b kl2 kl3 kl5 kcap kle kl4 klc klu klf atnk oldk  a Git killed from outside, exit code 1 and no output, read as check-ignore's none, grep's no line, rev-parse's no commit;
     r1 atbig atbig2 atnc atlnk  the first capture on an older shadow repo read the index again after the checks had read the older one: the person's
           ignored FILE gone (this lane's own regression), and every tracked file hashed again under one call's bound, which stopped every capture;
     old1-old6 oldat olddisk oldpr oldsys oldcap oldxdg oldc oldc2 olds  a rewind through the pin to a row an older store wrote wrote what it stored: a Git LFS file's pointer, LF for
           CRLF, UTF-8 for UTF-16. Refused now where a conversion could have changed what it stored;
     ghc ghv ghd ghi ghr gheq  Git 2.54's hooks in config ran on the shadow repo past core.hooksPath.
   Undo review 9 found, at b5355821, each with both calls ok:true unless it says otherwise (the block below says more):
     cs5 csa csb cs2 csl  a folder that reads case apart (Windows' per-folder case sensitivity: every folder WSL makes, any fsutil marks), where Git's
           core.ignorecase reads two names in A-Z case apart as one and opens `.gitignore` by its exact name: the person's untracked file
           kept out of the rewind's capture by a `.GITIGNORE` Git never reads there, then taken and deleted by the undo (since c8e20497),
           a file beside its twin in no row, and a capture that stored the person's file at its twin's length. Refused now, and a capture
           is skipped while such twins stand; csw csl2 refusals the same rule makes; cs6 cse csm csn csr the controls, both calls;
     ghe   a hook named "" ([hook ""]) was never switched off: it ran on the shadow repo and the undo answered git_failed.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The rows run four at a time (runRows): each owns its agent id, work tree, outside folders and its capped
   runner's list of cut-off listings, so none reads another's state or timing, and one that throws fails alone.
   ucap0-ucap3 use the real runner capped at 1500 bytes; the config rows give the real runner a spawn that sets
   GIT_CONFIG_GLOBAL for its own Git alone, the launch rows one that starts a program that does not exist for one Git verb,
   and the kill rows one that kills a real Git right after its start (process.kill: TerminateProcess(h, 1) on Windows, what
   taskkill /F gives; a signal elsewhere, which fails closed too). atbig and atbig2 alone answer for the runner: a timeout
   for a whole-tree hash while Git's own index shows no stat data; kl5 cuts a real answer off in its last line; oldsys and
   uafs answer one read of the file system. Every row runs against a real temp work tree and real git
   (test/helpers/checkpoint-rows.js says how the rows run and how Git is started); the rows' Git reads no global config or
   attributes file of the person's (a config row gives its own).
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), junctions (Windows) or directory
   symlinks (POSIX) to folders outside the work tree, all inside this test's own os.tmpdir() folder; a link is removed with
   `cmd /c rmdir` (Windows) / unlink before the folder is deleted. A folder that reads case apart is made with
   `fsutil file setCaseSensitiveInfo <folder> enable` (no administrator rights needed), and fsutil itself is asked that it
   does; where it cannot, the row says so and is skipped. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-reads-')));
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
    // ================= undo review 7: names Git and the file system read apart, the bytes, the person's Git config, a failed launch =================
    const outsideOf = (aid) => {
      const out = path.join(BASE, aid + '-outside');
      put(path.join(out, 'x.txt'), 'OUTSIDE x: no part of this work tree\n');
      put(path.join(out, 'other.txt'), 'OUTSIDE other\n');
      put(path.join(out, 'deep', 'y.txt'), 'OUTSIDE y\n');
      return out;
    };
    const noFold = (aid) => { if (foldsCase) return false; console.log('[skip] ' + aid + ': this file system does not fold case'); return true; };
    const apart = /are spelled apart in a letter outside A-Z, which Git reads as two names and the file system may read as one/;
    {
      // NAMES OUTSIDE A-Z (the security BLOCKER and MAJOR). Git's pathspec icase and its name hash fold A-Z alone; NTFS and the
      // store's foldPath fold letters with a case (each pair NTFS reads as one, and more: the store's THE FOLD), so a lookup of the junction uebung (u-umlaut) by Git's fold missed
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
      // undo review 8: a capital sigma at a name's end, which toLowerCase wrote as final sigma and NTFS reads as small sigma: in Greek both
      // ways round, and after a Latin letter
      const SIGMA = ['ΑΣ', 'ασ'], SIGMA_BACK = ['ασ', 'ΑΣ'], SIGMA_X = ['xΣ', 'xσ'];
      for (const [aid, pair] of [['uw1', LATIN], ['uw2', CYRILLIC], ['uw3', SIGMA], ['uw4', SIGMA_BACK], ['uw5', SIGMA_X]]) row(aid, async ({ refusedClean }) => {
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
      for (const [aid, pair] of [['ud1', LATIN], ['ud2', CYRILLIC], ['ud3', SIGMA], ['ud5', SIGMA_X]]) row(aid, async ({ refusedClean }) => {
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
      for (const [aid, pair] of [['ur3', LATIN], ['ur3c', CYRILLIC], ['ur3s', SIGMA], ['ur3x', SIGMA_X]]) row(aid, async ({ refusedClean }) => {
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
      for (const [aid, pair] of [['us1', LATIN], ['us2', SIGMA], ['us4', SIGMA_X]]) row(aid, async () => {
        if (noFold(aid)) return;
        const [up, lo] = pair, wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, up, 'x.txt'), 'T x\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + up + '/x.txt' });
        fs.rmSync(path.join(wt, up), { recursive: true });
        link(out, path.join(wt, lo));
        put(path.join(wt, 'app.js'), 'v1\n');
        const s = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S: a junction in the other case' });
        A.ok(!!(s && s.created), aid + ': the snapshot is taken');
        A.eq([!!s && (await tree(aid, s.id)).includes(up + '/x.txt'), s && (s.links || []).map((l) => l.path)], [false, [lo]], aid + ': its tree drops ' + up + '/x.txt, read through nothing, and it records the junction ' + lo);
      });
      for (const [aid, body, up, lo] of [['uu1', 'the person\'s edit, renamed, no capture took this\n', 'Éa.txt', 'éa.txt'], ['uu2', 'same bytes\n', 'Éa.txt', 'éa.txt'],
        ['uu3', 'the person\'s edit, renamed, no capture took this\n', 'ασ', 'ΑΣ']]) row(aid, async ({ refusedClean }) => {
        if (noFold(aid)) return;
        const wt = path.join(ROOT, aid);
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
      row('atri', async ({ twoCalls }) => {
        const aid = 'atri', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n';
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, maxRepoBytes: 1 });
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(path.join(wt, 'app.js'), mixed);
        const s = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: past the size ceiling at once' });
        A.eq([!!(s && s.maintenance && s.maintenance.reinit), await blobOf(aid, 'HEAD', 'app.js')], [true, mixed], 'atri: the size ceiling\'s re-init stores the bytes as they are too');
        put(path.join(wt, 'app.js'), 'edited, no snapshot took this\n');
        await twoCalls(st, aid, wt, s.id, 'atri, a rewind to the re-init\'s baseline under its text=auto rule');
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
    // ================= undo review 8: a fold that is not the file system's, the first capture on an older shadow repo, a Git killed from outside, an older row's bytes, hooks in config =================
    const shadowOf = (aid) => ['--git-dir', gitDirOf(aid), '--work-tree', path.join(ROOT, aid)].concat(ident);
    const blobIn = async (aid, id, name) => Buffer.from(await gitRun(['--git-dir', gitDirOf(aid), 'cat-file', 'blob', String(id).split(':').pop() + ':' + name])).toString('latin1');
    // the real runner with a spawn of the row's own, and a store over it
    const storeOver = (spawnIt, extra) => makeCheckpointStore(Object.assign({ fs, pathMod: path, root: ROOT, clock, keep: 50,
      runGit: makeCheckpointGitRunner({ spawn: spawnIt, clock: { now: () => Date.now() }, timeoutMs: 60000 }) }, extra || {}));
    const configFile = (aid, text) => { const file = path.join(BASE, aid + '-gitconfig'); fs.writeFileSync(file, text); return file; };
    const withGlobal = (file) => (f, argv, options) => launchSpawn(f, argv, Object.assign({}, options, { env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: file }) }));
    {
      // THE FOLD, ONE MORE WAY EACH (the security and correctness BLOCKERS; uw3-uw5 ud3-ud5 ur3s ur3b ur3x us2-us4 uu3 above). A lookup here read a
      // capital sigma at a name's end as final sigma, and NTFS reads it as small sigma: every check said nothing stands there. Below, the
      // review's S3 S4 S5 S7, both ways round: sg3 the person's ignored FILE written over, in no row; sg4 a folder's ignored file gone with the
      // folder; sg5 a junction's target emptied; sg7 a clone's uncommitted edit written over. ovk ova ovg: the other way, a name the fold reads
      // as one with another that NTFS keeps apart (the Kelvin sign and k, the Angstrom sign and a-ring, a word in final sigma and in capitals):
      // T's FILE replaced the folder of its own name, only a junction in it, and the walk's maps kept the other folder's spelling: the
      // outside x.txt gone, ok:true on both calls. Refused now, whichever a lookup finds. ovkb ovkc ovkd ovke: a name that reads as all ASCII has no list of
      // names outside A-Z to meet its twin in, so a rewind went ahead and left the two side by side, or spelled apart, for its undo to refuse on every try: T's k and its
      // Kelvin twin, FILES or folders (ovkb ovkc), T's k/x.txt with an ignored Kelvin folder standing (ovkd), T's k with the undo row's Kelvin twin (ovke: 2caa2665 the same),
      // the other way round refused all along (ovkf). A tree or a listed folder that holds one refuses a rewind now. ovt: T's two names the fold alone reads as one: refused too,
      // so no rewind makes such a pair. ovkk, the control: a plain k, both calls. uafs: the file system answers for a name no listing
      // shows in either fold (a fold no sweep of this volume can vouch for: macOS's normalization, here an injected lstat): refused, and the same
      // tree through the plain file system, which keeps the two apart, goes ahead both ways
      const noFoldHere = (aid) => { if (foldsCase) return false; console.log('[skip] ' + aid + ': this file system does not fold case'); return true; };
      for (const [aid, up, lo] of [['sg3', 'ΑΣ', 'ασ'], ['sg3b', 'ασ', 'ΑΣ']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, lo + '-env'), 'T env\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'S0' });
        put(path.join(wt, '.gitignore'), '*-env\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: the rule, ' + lo + '-env still tracked' });
        fs.unlinkSync(path.join(wt, lo + '-env'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: the file gone' });
        put(path.join(wt, up + '-env'), 'the person\'s, ignored, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^".*-env" as it is now is in no restore point \(Git ignores it\)/, aid + ', a rewind that would write ' + lo + '-env over the ignored ' + up + '-env');
      });
      for (const [aid, up, lo] of [['sg4', 'ΑΣ', 'ασ'], ['sg4b', 'ασ', 'ΑΣ']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, lo), 'T: the FILE\n');
        put(path.join(wt, '.gitignore'), '*.log\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE ' + lo });
        fs.unlinkSync(path.join(wt, lo));
        put(path.join(wt, up, 'keep.log'), 'the person\'s, ignored, in no restore point\n');
        put(path.join(wt, up, 'a.txt'), 'captured\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /keep\.log" as it is now is in no restore point \(Git ignores it\), inside the folder/, aid + ', a rewind that would replace the folder ' + up + ', an ignored file in it, with the FILE ' + lo);
      });
      for (const [aid, up, lo] of [['sg5', 'ΑΣ', 'ασ'], ['sg5b', 'ασ', 'ΑΣ']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid), out = outsideOf(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, lo), 'T: the FILE\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE ' + lo });
        fs.unlinkSync(path.join(wt, lo));
        fs.mkdirSync(path.join(wt, up));
        link(out, path.join(wt, up, 'j'));
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        const seen = listing(out);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /in no restore point \(Git ignores it\)/, aid + ', a rewind that would replace the folder ' + up + ', a junction in it, with the FILE ' + lo);
        A.eq(listing(out), seen, aid + ': every path and byte outside the work tree is untouched');
      });
      for (const [aid, up, lo] of [['sg7', 'ΑΣ', 'ασ']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, lo, 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + lo + '/x.txt' });
        fs.rmSync(path.join(wt, lo), { recursive: true });
        await clone(path.join(wt, up), { 'x.txt': 'clone x\n' });
        put(path.join(wt, up, 'x.txt'), 'clone x, an uncommitted edit\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apart, aid + ', a rewind that would write ' + lo + '/x.txt into a clone at ' + up);
      });
      const KELVIN = '\u212a', asPlain = /holds a letter outside A-Z that the checks of a rewind read as a plain one \(the Kelvin sign, as k\)/;
      for (const [aid, first, second, what] of [['ovk', 'k', KELVIN, 'the Kelvin sign beside k'], ['ova', '\u00e5', '\u212b', 'the Angstrom sign beside a-ring'],
        ['ovg', 'ΕΡΓΑΣΙΕΣ', 'εργασιες', 'a word in final sigma beside the same word in capitals']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid), out = outsideOf(aid), out1 = outsideOf(aid + 'b');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitignore'), '!lnk\n!lnk1\n');
        put(path.join(wt, second), 'T: the FILE\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE ' + what });
        fs.rmSync(path.join(wt, second));
        put(path.join(wt, 'app.js'), 'v1\n');
        put(path.join(wt, second, 'plain.txt'), 'plain\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the folder' });
        fs.mkdirSync(path.join(wt, first));
        if (fs.readdirSync(wt).filter((n) => n === first || n === second).length !== 2) { console.log('[skip] ' + aid + ': this file system reads the two as one'); return; }
        link(out1, path.join(wt, first, 'lnk1'));
        link(out, path.join(wt, second, 'lnk'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out), seen1 = listing(out1);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', aid === 'ovk' ? asPlain : /stand side by side, spelled apart in a letter outside A-Z/, aid + ', ' + what + ', T\'s FILE over a folder of its own name, only a junction in it');
        A.eq([listing(out), listing(out1)], [seen, seen1], aid + ': every path and byte outside the work tree is untouched');
      });
      // T's two names, nothing of them there now: as FILES (ovkb), as folders (ovkc); the fold alone reads them as one (ovt: both outside ASCII)
      for (const [aid, a, b, sub, re] of [['ovkb', 'k', KELVIN, '', asPlain], ['ovkc', 'k', KELVIN, 'x.txt', asPlain], ['ovt', '\u00e5', '\u212b', '', /are spelled apart in a letter outside A-Z/]]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, a, sub), 'T a\n');
        put(path.join(wt, b, sub), 'T b\n');
        if (fs.readdirSync(wt).filter((n) => n === a || n === b).length !== 2) { console.log('[skip] ' + aid + ': this file system reads the two as one'); return; }
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: two names' });
        fs.rmSync(path.join(wt, a), { recursive: true });
        fs.rmSync(path.join(wt, b), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: neither' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', re, aid + ', a rewind that would make two names side by side, which its undo would refuse');
      });
      row('ovkd', async ({ refusedClean }) => {
        const aid = 'ovkd';
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitignore'), KELVIN + '\n');
        put(path.join(wt, 'k', 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: k/x.txt' });
        fs.rmSync(path.join(wt, 'k'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no k' });
        put(path.join(wt, KELVIN, 'keep.txt'), 'the person\'s, ignored, in no restore point\n');
        if (!fs.readdirSync(wt).includes(KELVIN)) { console.log('[skip] ' + aid + ': this file system does not keep the name'); return; }
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', asPlain, 'ovkd, a rewind that would make k beside an ignored Kelvin folder');
      });
      for (const [aid, inT, inRow] of [['ovke', 'k', KELVIN], ['ovkf', KELVIN, 'k']]) row(aid, async ({ refusedClean }) => {
        if (noFoldHere(aid)) return;
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, inT), 'T\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + inT });
        fs.rmSync(path.join(wt, inT));
        put(path.join(wt, inRow), 'the person\'s, no capture took this\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', asPlain, aid + ', a rewind whose undo would have to find the one name through the other');
      });
      row('ovkk', async ({ twoCalls }) => {
        const aid = 'ovkk', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'k', 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: k/x.txt' });
        fs.rmSync(path.join(wt, 'k'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await twoCalls(store, aid, wt, t.id, 'ovkk, a plain k with no Kelvin sign anywhere');
      });
      row('uafs', async ({ twoCalls, refusedClean }) => {
        const aid = 'uafs';
        if (!isWin) { console.log('[skip] uafs: drives the plain file system of Windows, which keeps these two names apart'); return; }
        const wt = path.join(ROOT, aid), out = outsideOf(aid), nfd = 'e\u0301', nfc = '\u00e9';
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, nfd, 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: decomposed' });
        fs.rmSync(path.join(wt, nfd), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the folder gone' });
        link(out, path.join(wt, nfc));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const seen = listing(out);
        const promises = Object.assign(Object.create(fs.promises), { lstat: (p, ...rest) => fs.promises.lstat(String(p).normalize('NFC'), ...rest) });
        const normalizing = Object.create(fs);
        Object.defineProperty(normalizing, 'promises', { value: promises });
        const st = makeCheckpointStore({ fs: normalizing, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /what the file system reads under that name/, 'uafs, a rewind that would write through a name the file system answers for and no listing shows');
        await twoCalls(store, aid, wt, t.id, 'uafs, the plain file system, which keeps the two apart');
        A.eq(listing(out), seen, 'uafs: every path and byte outside the work tree is untouched');
      });
    }
    {
      // A GIT KILLED FROM OUTSIDE (the two BLOCKERS' ruling): taskkill /F ends a process with exit code 1 and no signal,
      // what a spawn hook's process.kill does on Windows, so the runner answered { code: 1 } with no output, Git's own "none". kl1, kl1b:
      // check-ignore: the person's ignored file written over or deleted, ok:true on both calls. kl2: grep of the staged tree's .gitignore: no
      // rule read, and the rewind's undo refused on every try. kl3: rev-parse in the first capture on an older shadow repo: read as "no
      // commit yet", the index emptied, a tracked ignored file out of the capture and written over. Each is no answer now: check-ignore prints a
      // line for every name asked (-v -n), grep's 1 counts only where each file asked is empty or not there, rev-parse's only where Git lists
      // no ref. Each row has its control first; the file that is empty goes ahead (kle: grep's own 1); and kl4: the same check-ignore
      // asked through a negation still says so (a rule that re-includes is not one that ignores). kl5: a line a kill cut off counts for nothing (the real
      // Git's answer cut, as a pipe read to a kill gives it). klc klu klf: the Git calls of this repair, killed: refused, and the next try goes ahead both ways. kcap: through the
      // real capped runner, that longer answer past its limit is asked in halves, and one name past it is no answer
      const killing = () => {
        const state = { when: null, killed: 0 };
        const st = storeOver((file, argv, options) => {
          const child = launchSpawn(file, argv, options);
          if (state.when && state.when(argv)) { state.killed++; try { process.kill(child.pid); } catch (_) {} }
          return child;
        });
        return { state: state, st: st };
      };
      for (const [aid, name, tracked] of [['kl1', 'keep.env', 'keep.env'], ['kl1b', 'logs', 'logs/a.txt']]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid), { state, st } = killing();
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, tracked), 'a, in T\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + tracked });
        fs.rmSync(path.join(wt, name), { recursive: true });
        put(path.join(wt, '.gitignore'), name + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule, the path gone' });
        put(path.join(wt, name), 'the person\'s ignored FILE, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_in_path', /in no restore point \(Git ignores it\)/, aid + '\'s control, no Git killed');
        state.when = (argv) => argv.includes('check-ignore');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not say which files it ignores/, aid + ', a rewind whose check-ignore was killed from outside');
        A.ok(state.killed > 0, 'fixture (' + aid + '): that Git was killed');
      });
      row('kl2', async ({ refusedClean }) => {
        const aid = 'kl2', wt = path.join(ROOT, aid), { state, st } = killing();
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no .gitignore' });
        put(path.join(wt, '.gitignore'), '*.log\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a glob rule' });
        put(path.join(wt, 'x.log'), 'the person\'s ignored log, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /rewinding changes the rule "\*\.log"/, 'kl2\'s control, no Git killed');
        state.when = (argv) => argv.includes('grep') && !argv.includes(String(t.id));   // the staged tree's read, not the target's
        await refusedClean(st, aid, wt, t.id, 'link_check_failed', /the \.gitignore files its undo would bring back could not be read/, 'kl2, a rewind whose read of the staged tree\'s .gitignore was killed from outside');
        A.ok(state.killed > 0, 'fixture (kl2): that Git was killed');
      });
      row('kl3', async ({ twoCalls, refusedClean }) => {
        const aid = 'kl3', wt = path.join(ROOT, aid), edit = 'the person\'s edit of a tracked, ignored file\n', { state, st } = killing();
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'keep.env'), 'tracked before its rule, v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, '.gitignore'), 'keep.env\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule, keep.env still tracked' });
        put(path.join(wt, 'keep.env'), edit);
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        state.when = (argv) => argv.includes('rev-parse') && argv.includes('--verify');
        await refusedClean(st, aid, wt, t.id, 'pre_restore_failed', /could not read the last restore point again/, 'kl3, a first capture on an older shadow repo, its rev-parse killed from outside');
        A.ok(state.killed > 0, 'fixture (kl3): that Git was killed');
        state.when = null;
        const { r } = await twoCalls(st, aid, wt, t.id, 'kl3, the next try');
        A.eq(r && r.preRestoreId ? await blobIn(aid, r.preRestoreId, 'keep.env') : null, edit, 'kl3: the undo row holds the edit of the tracked, ignored file');
      });
      row('kl5', async ({ refusedClean }) => {
        const aid = 'kl5', wt = path.join(ROOT, aid), name = 'keep.env';
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => {
          const r = await runGit(args, opts);
          return args.includes('check-ignore') ? Object.assign({}, r, { code: 1, stdout: String(r.stdout).slice(0, -5) }) : r;
        } });
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, name), 'T env\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.unlinkSync(path.join(wt, name));
        put(path.join(wt, '.gitignore'), name + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule, the file gone' });
        put(path.join(wt, name), 'the person\'s ignored FILE, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not say which files it ignores/, 'kl5, a rewind whose check-ignore answer a kill cut off in its last line');
      });
      row('kcap', async ({ cut, refusedClean }) => {
        const aid = 'kcap', wt = path.join(ROOT, aid), names = Array.from({ length: 30 }, (_, i) => flatName(i).replace('.bin', '.env'));
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
        put(path.join(wt, 'app.js'), 'v0\n');
        for (const n of names) put(path.join(wt, n), 'T env\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 30 long names' });
        for (const n of names) fs.unlinkSync(path.join(wt, n));
        put(path.join(wt, '.gitignore'), '*.env\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the rule, the files gone' });
        for (const n of names) put(path.join(wt, n), 'the person\'s ignored FILE, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        cut.length = 0;
        await refusedClean(st, aid, wt, t.id, 'uncaptured_in_path', /in no restore point \(Git ignores it\)/, 'kcap, a rewind whose check-ignore answer passes the capped runner\'s limit');
        A.ok(cut.includes('check-ignore'), 'kcap: that answer passed the limit (' + JSON.stringify(cut) + ')');
      });
      for (const [aid, verb, reason, re] of [
        ['klc', 'config', 'pre_restore_failed', /could not say which hooks/],
        ['klu', 'update-index', 'pre_restore_failed', /could not read every tracked file again/],
        ['klf', 'cat-file', 'uncaptured_check_failed', /could not read what the restore point says/]
      ]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid), { state, st } = killing();
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        state.when = (argv) => argv.includes(verb);
        await refusedClean(st, aid, wt, t.id, reason, re, aid + ', a rewind whose ' + verb + ' was killed from outside');
        A.ok(state.killed > 0, 'fixture (' + aid + '): that Git was killed');
        state.when = null;
        await twoCalls(st, aid, wt, t.id, aid + ', the next try');
      });
      row('kle', async ({ twoCalls }) => {
        const aid = 'kle', wt = path.join(ROOT, aid), { st } = killing();
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no .gitignore' });
        put(path.join(wt, '.gitignore'), '');
        put(path.join(wt, 'app.js'), 'v1\n');
        await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: an empty .gitignore' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await twoCalls(st, aid, wt, t.id, 'kle, a rewind that drops an empty .gitignore, which grep answers with its own 1');
      });
      row('kl4', async ({ twoCalls }) => {
        const aid = 'kl4', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitignore'), '*.env\n!keep.env\n');
        put(path.join(wt, 'keep.env'), 'T env\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.unlinkSync(path.join(wt, 'keep.env'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the file gone' });
        put(path.join(wt, 'keep.env'), 'the person\'s, captured: a negation re-includes it\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { r } = await twoCalls(store, aid, wt, t.id, 'kl4, a rewind over a file a negation re-includes');
        A.eq(r && r.preRestoreId ? await blobIn(aid, r.preRestoreId, 'keep.env') : null, 'the person\'s, captured: a negation re-includes it\n', 'kl4: the undo row holds it');
      });
    }
    {
      // THE FIRST CAPTURE ON AN OLDER SHADOW REPO (the security BLOCKER and both MAJORS). It reads the index from the last commit again, with no stat
      // data, once. r1: the checks read the older index, and that read came after them: a FILE only that index held (its add ran and its
      // commit did not: killed, a failing gpg sign) counted as captured, and the read dropped it: the person's ignored FILE logs gone, ok:true
      // on both calls. Now it comes before anything reads the index. atbig: every tracked file hashed again under one call's 15 s bound: past it
      // a killed add wrote no index, the pin was on disk, so every capture and rewind failed from then on (the review's probes take a 1 s bound and
      // 12000 files; here the runner answers a timeout for a whole-tree hash while the index has no stat data, asked of Git itself, so the row
      // costs no such tree). Now that read has the maintenance bound and its own step. atbig2: past that bound too: refused, the marker stays,
      // and the next try reads every file. atnc: an older store's add with no commit at all: its blobs read again too
      row('r1', async ({ refusedClean }) => {
        const aid = 'r1', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'logs', 'a.txt'), 'a\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(wt, 'logs'), { recursive: true });
        put(path.join(wt, 'logs'), 'the person\'s ignored FILE, in no restore point\n');
        await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
        put(path.join(wt, '.gitignore'), 'logs\n');
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        A.eq([(await gitIn(aid, ['ls-files', '--', 'logs'])).out.trim(), (await gitIn(aid, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'logs'])).out.trim()], ['logs', 'logs/a.txt'], 'fixture (r1): the older index is ahead of its last commit');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_in_path', /^"logs" as it is now is in no restore point \(Git ignores it\)/, 'r1, a rewind on an older shadow repo whose index alone holds the ignored FILE logs');
      });
      const boundModel = (aid, extra) => {
        const state = { timedOut: 0, long: [], refuseLong: false };
        const late = { code: -1, stdout: '', stderr: '\ncheckpoint Git process tree timed out', timedOut: true };
        const statLess = async () => /mtime: 0:0/.test((await gitIn(aid, ['ls-files', '--debug', '--', 'keep.txt'])).out);
        const wholeTree = (args) => args.includes('add') || args.includes('update-index') || (args.includes('diff-index') && !args.includes('--'));
        const st = makeCheckpointStore(Object.assign({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => {
          if (wholeTree(args) && await statLess()) {
            if (!(opts && opts.timeoutMs)) { state.timedOut++; return late; }
            state.long.push(args.find((a) => a === 'add' || a === 'update-index' || a === 'diff-index'));
            if (state.refuseLong) return late;
          }
          return runGit(args, opts);
        } }, extra || {}));
        return { state: state, st: st };
      };
      row('atbig', async ({ twoCalls }) => {
        const aid = 'atbig', wt = path.join(ROOT, aid), { state, st } = boundModel(aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'keep.txt'), 'never edited\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        for (let i = 0; i < 3; i++) {
          put(path.join(wt, 'app.js'), 'edit ' + i + '\n');
          const s = await st.snapshot(aid, { runId: 'r', turn: 2 + i, label: 'capture ' + i });
          A.ok(!!(s && s.created), 'atbig: capture ' + i + ' on the older shadow repo is taken (' + JSON.stringify(st.health(aid) && st.health(aid).lastFailure) + ')');
        }
        A.eq([state.timedOut, state.long.length > 0, fs.existsSync(path.join(gitDirOf(aid), 'starnet-reread-due'))], [0, true, false], 'atbig: the read of every tracked file ran once, under the maintenance bound, and is done');
        put(path.join(wt, 'app.js'), 'v9, no snapshot took this\n');
        await twoCalls(st, aid, wt, t.id, 'atbig, a rewind on that repo');
      });
      row('atbig2', async ({ twoCalls, refusedClean }) => {
        const aid = 'atbig2', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n', file = path.join(wt, 'app.js'), { state, st } = boundModel(aid);
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(path.join(wt, 'keep.txt'), 'never edited\n');
        put(file, 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        put(file, mixed);
        const long = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(file, long, long);
        await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
        await gitRun(shadowOf(aid).concat(['commit', '-q', '-m', 'as an older store captured it']), { cwd: wt });
        state.refuseLong = true;
        A.eq(await st.snapshot(aid, { runId: 'r', turn: 1, label: 'past both bounds' }), null, 'atbig2: a capture past the maintenance bound too is skipped');
        A.ok(/within its time limit/.test(st.health(aid).lastFailure.reason), 'atbig2: and health says why (' + JSON.stringify(st.health(aid).lastFailure) + ')');
        await refusedClean(st, aid, wt, t.id, 'pre_restore_failed', /within its time limit/, 'atbig2, a rewind past the maintenance bound too');
        A.eq(fs.existsSync(path.join(gitDirOf(aid), 'starnet-reread-due')), true, 'atbig2: the read is still due');
        state.refuseLong = false;
        const { r } = await twoCalls(st, aid, wt, t.id, 'atbig2, the next try');
        A.eq(r && r.preRestoreId ? await blobIn(aid, r.preRestoreId, 'app.js') : null, mixed, 'atbig2: the undo row\'s blob is the person\'s bytes');
      });
      // atlnk: that hash, before the walk, reads a tracked path through a junction standing since, to compare it: nothing of the outside folder is stored, and the capture's
      // boundary then drops that path
      row('atlnk', async ({ refusedClean }) => {
        const aid = 'atlnk', wt = path.join(ROOT, aid), out = outsideOf(aid), body = 'the outside folder\'s bytes\n';
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'jx', 'secret.txt'), 'T secret\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: jx/secret.txt' });
        fs.rmSync(path.join(wt, 'jx'), { recursive: true });
        put(path.join(out, 'secret.txt'), body);
        link(out, path.join(wt, 'jx'));
        fs.rmSync(path.join(gitDirOf(aid), 'info', 'attributes'), { force: true });
        const seen = listing(out);
        put(path.join(wt, 'app.js'), 'v1\n');
        const s = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S: the first capture on that older repo' });
        const sha = (await gitRun(['hash-object', '--no-filters', path.join(out, 'secret.txt')])).trim();
        A.eq([!!(s && s.created), !!s && (await tree(aid, s.id)).includes('jx/secret.txt'), s && (s.links || []).map((l) => l.path), (await gitIn(aid, ['cat-file', '-e', sha])).code !== 0], [true, false, ['jx'], true], 'atlnk: the capture is taken, its tree drops jx/secret.txt, it records the junction, and the outside bytes are no object of the shadow repo');
        await refusedClean(store, aid, wt, t.id, 'link_in_path', /is a link \(a junction, symbolic link or mount point\), and rewinding would write or delete/, 'atlnk, a rewind through that junction');
        A.eq(listing(out), seen, 'atlnk: every path and byte outside the work tree is untouched');
      });
      row('atnc', async () => {
        const aid = 'atnc', wt = path.join(ROOT, aid), mixed = 'one\ntwo\r\n', file = path.join(wt, 'app.js');
        fs.mkdirSync(gitDirOf(aid), { recursive: true });
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(file, mixed);
        const long = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(file, long, long);
        await gitRun(shadowOf(aid).concat(['init', '-q']), { cwd: wt });
        await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
        const s = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'the first capture after an older store\'s add with no commit' });
        A.ok(!!(s && s.created), 'atnc: the capture is taken');
        A.eq(s ? await blobIn(aid, s.id, 'app.js') : null, mixed, 'atnc: its blob is the person\'s bytes');
      });
      row('atnk', async () => {
        const aid = 'atnk', wt = path.join(ROOT, aid), file = path.join(wt, 'app.js');
        const state = { when: null, killed: 0 }, st = storeOver((f, argv, options) => {
          const child = launchSpawn(f, argv, options);
          if (state.when && state.when(argv)) { state.killed++; try { process.kill(child.pid); } catch (_) {} }
          return child;
        });
        fs.mkdirSync(gitDirOf(aid), { recursive: true });
        put(file, 'v0\n');
        await gitRun(shadowOf(aid).concat(['init', '-q']), { cwd: wt });
        await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
        state.when = (argv) => argv.includes('for-each-ref');
        A.eq(await st.snapshot(aid, { runId: 'r', turn: 0, label: 'no commit, its for-each-ref killed' }), null, 'atnk: a capture that cannot tell "no commit yet" from a Git killed from outside is skipped');
        A.eq([state.killed > 0, (await gitIn(aid, ['ls-files'])).out.trim()], [true, 'app.js'], 'atnk: and its index stands');
        state.when = null;
        const s = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'the next try' });
        A.ok(!!(s && s.created), 'atnk: the next try is taken');
      });
    }
    {
      // A ROW AN OLDER STORE WROTE (the correctness BLOCKER). The pin stops every conversion on the way out too, and such a row holds the converted
      // blob: old1 a CRLF file under eol=crlf came back with LF, old2 a UTF-16 file as UTF-8, old3 (the review's probe, with the real git-lfs) a Git
      // LFS file as its pointer text, ok:true. Every commit since says it stores the bytes as they are; a rewind to one that does not is refused
      // where a conversion could have changed what it stored: old4 in a folder's .gitattributes, old6 in one only the row holds, old5 in a .GITATTRIBUTES where the file system
      // folds case, oldat under core.attributesFile, olddisk under an ignored .gitattributes no tree holds, oldpr the same in an ignored folder the walk never entered,
      // whose tracked file only the link check's listing reaches, oldsys under the system's own attributes file (its text an injected read: no row writes where Git
      // keeps it), and oldxdg (below, alone) under the file Git reads when core.attributesFile is not set. oldcap: the capped runner: a listing of them past its limit is no
      // answer. oldk: where Git keeps the system's file, killed from outside. The controls,
      // both calls: oldc no rule at all, oldc2 rules that convert nothing, olds the first capture on such a repo with nothing changed, which gets a
      // row of its own (a rewind to it goes ahead, and the next unchanged capture dedups onto it). Each older row below is written by Git's
      // plumbing as trunk's store wrote it, under no pin, and read back through the index rebuild, the row's id its commit
      const older = async (aid, wt, label) => {
        if (!fs.existsSync(path.join(gitDirOf(aid), 'HEAD'))) {
          fs.mkdirSync(gitDirOf(aid), { recursive: true });
          await gitRun(shadowOf(aid).concat(['init', '-q']), { cwd: wt });
        }
        await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
        await gitRun(shadowOf(aid).concat(['commit', '-q', '--allow-empty', '-m', label]), { cwd: wt });
        return (await gitRun(['--git-dir', gitDirOf(aid), 'rev-parse', 'HEAD'])).trim();
      };
      const olderWords = /^this restore point is older than the checkpoint's byte-exact storage/;
      const utf16 = (t) => Buffer.from(t, 'utf16le');
      for (const [aid, attrFile, attrs, name, body, blob] of [
        ['old1', '.gitattributes', '*.txt text eol=crlf\n', 'a.txt', Buffer.from('one\r\ntwo\r\n'), 'one\ntwo\n'],
        ['old2', '.gitattributes', '*.txt working-tree-encoding=UTF-16LE\n', 'a.txt', utf16('one\ntwo\n'), 'one\ntwo\n'],
        ['old3', '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'a.bin', Buffer.from('binary bytes\n'), null],
        ['old4', 'sub/.gitattributes', '*.txt text eol=crlf\n', 'sub/a.txt', Buffer.from('one\r\ntwo\r\n'), 'one\ntwo\n'],
        ['old5', '.GITATTRIBUTES', '*.txt text eol=crlf\n', 'a.txt', Buffer.from('one\r\ntwo\r\n'), 'one\ntwo\n']
      ]) row(aid, async ({ refusedClean }) => {
        if (attrFile !== attrFile.toLowerCase() && !foldsCase) { console.log('[skip] ' + aid + ': this file system does not fold case'); return; }
        const wt = path.join(ROOT, aid);
        put(path.join(wt, attrFile), attrs);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, name), body);
        const t = await older(aid, wt, 'T, under no pin');
        if (blob != null) A.eq(await blobIn(aid, t, name), blob, 'fixture (' + aid + '): the older row\'s blob is the converted one');
        put(path.join(wt, name), Buffer.concat([body, Buffer.from('edit')]));
        put(path.join(wt, 'app.js'), 'v1\n');
        await older(aid, wt, 'S1, under no pin');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await store.listResilient(aid);
        const r = await refusedClean(store, aid, wt, t, 'uncaptured_check_failed', olderWords, aid + ', a rewind to a row an older store wrote under ' + attrs.trim());
        A.ok(String(r && r.detail).indexOf(attrFile) >= 0, aid + ': the refusal names ' + attrFile + ' (' + JSON.stringify(r && r.detail) + ')');
      });
      // old6: the rule in the row alone, gone from the folder since
      row('old6', async ({ refusedClean }) => {
        const aid = 'old6', wt = path.join(ROOT, aid);
        put(path.join(wt, '.gitattributes'), '*.txt text eol=crlf\n');
        put(path.join(wt, 'a.txt'), 'one\r\ntwo\r\n');
        const t = await older(aid, wt, 'T, under no pin');
        A.eq(await blobIn(aid, t, 'a.txt'), 'one\ntwo\n', 'fixture (old6): the older row\'s blob is the converted one');
        fs.unlinkSync(path.join(wt, '.gitattributes'));
        put(path.join(wt, 'a.txt'), 'edited, no snapshot took this\n');
        await store.listResilient(aid);
        await refusedClean(store, aid, wt, t, 'uncaptured_check_failed', /its "\.gitattributes" asks Git to convert files/, 'old6, a rewind to a row an older store wrote, its rule gone from the folder since');
      });
      row('oldat', async ({ refusedClean }) => {
        const aid = 'oldat', wt = path.join(ROOT, aid), attrs = path.join(BASE, aid + '-attributes');
        fs.writeFileSync(attrs, '* text=auto\n');
        const st = storeOver(withGlobal(configFile(aid, '[core]\n\tattributesFile = "' + attrs.split(path.sep).join('/') + '"\n')));
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await older(aid, wt, 'T, under no pin');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await store.listResilient(aid);
        await refusedClean(st, aid, wt, t, 'uncaptured_check_failed', /your Git config sets core\.attributesFile/, 'oldat, a rewind to a row an older store wrote, under the person\'s core.attributesFile');
      });
      row('olddisk', async ({ refusedClean }) => {
        const aid = 'olddisk', wt = path.join(ROOT, aid);
        put(path.join(wt, '.gitignore'), '.gitattributes\n');
        put(path.join(wt, '.gitattributes'), '*.txt text eol=crlf\n');
        put(path.join(wt, 'a.txt'), 'one\r\ntwo\r\n');
        const t = await older(aid, wt, 'T, under no pin');
        A.eq([await blobIn(aid, t, 'a.txt'), (await tree(aid, t)).includes('.gitattributes')], ['one\ntwo\n', false], 'fixture (olddisk): T holds the converted blob and no .gitattributes');
        put(path.join(wt, 'a.txt'), 'one\r\ntwo\r\nedit\r\n');
        await store.listResilient(aid);
        await refusedClean(store, aid, wt, t, 'uncaptured_check_failed', /"\.gitattributes" in your folder asks Git to convert files/, 'olddisk, a rewind to a row an older store wrote under an ignored .gitattributes');
      });
      row('oldpr', async ({ refusedClean }) => {
        const aid = 'oldpr', wt = path.join(ROOT, aid), file = path.join(wt, 'build', 'a.txt');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(file, 'one\r\n');
        await older(aid, wt, 'S0: build/a.txt, no rule yet');
        put(path.join(wt, '.gitignore'), 'build\n');
        put(path.join(wt, 'build', '.gitattributes'), '*.txt text eol=crlf\n');
        put(file, 'one\r\ntwo\r\n');
        const t = await older(aid, wt, 'T: tracked below the rule, under an ignored .gitattributes');
        A.eq([await blobIn(aid, t, 'build/a.txt'), (await tree(aid, t)).includes('build/.gitattributes')], ['one\ntwo\n', false], 'fixture (oldpr): T holds the converted blob and no .gitattributes');
        put(file, 'one\r\ntwo\r\nedit\r\n');
        await store.listResilient(aid);
        await refusedClean(store, aid, wt, t, 'uncaptured_check_failed', /"build\/\.gitattributes" in your folder asks Git to convert files/, 'oldpr, a rewind to a row an older store wrote under an ignored .gitattributes in an ignored folder');
      });
      row('oldsys', async ({ refusedClean }) => {
        const aid = 'oldsys', wt = path.join(ROOT, aid);
        let sysFile = '';
        try { sysFile = (await gitRun(['var', 'GIT_ATTR_SYSTEM'])).trim(); } catch (e) { if (e.status !== 129) throw e; }
        if (!sysFile) { console.log('[skip] oldsys: this Git cannot say where its system attributes file is'); return; }
        const promises = Object.assign(Object.create(fs.promises), { readFile: (p, ...rest) => (String(p) === sysFile ? Promise.resolve('* text=auto\n') : fs.promises.readFile(p, ...rest)) });
        const answering = Object.create(fs);
        Object.defineProperty(answering, 'promises', { value: promises });
        const st = makeCheckpointStore({ fs: answering, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await older(aid, wt, 'T, under no pin');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await store.listResilient(aid);
        await refusedClean(st, aid, wt, t, 'uncaptured_check_failed', /your Git reads an attributes file of its own/, 'oldsys, a rewind to a row an older store wrote, under the system\'s attributes file');
      });
      row('oldk', async ({ twoCalls, refusedClean }) => {
        const aid = 'oldk', wt = path.join(ROOT, aid), state = { killed: 0, on: true };
        const st = storeOver((f, argv, options) => {
          const child = launchSpawn(f, argv, options);
          if (state.on && argv.includes('var')) { state.killed++; try { process.kill(child.pid); } catch (_) {} }
          return child;
        });
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await older(aid, wt, 'T, under no pin');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await store.listResilient(aid);
        await refusedClean(st, aid, wt, t, 'uncaptured_check_failed', /could not read what the restore point says/, 'oldk, a rewind to an older row, where Git keeps its system file killed from outside');
        A.ok(state.killed > 0, 'fixture (oldk): that Git was killed');
        state.on = false;
        await twoCalls(st, aid, wt, t, 'oldk, the next try');
      });
      row('oldcap', async ({ cut, refusedClean }) => {
        const aid = 'oldcap', wt = path.join(ROOT, aid);
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 30; i++) put(path.join(wt, flatName(i).replace('.bin', ''), '.gitattributes'), '# nothing converts here\n');
        const t = await older(aid, wt, 'T: 30 .gitattributes files');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await store.listResilient(aid);
        await refusedClean(st, aid, wt, t, 'uncaptured_check_failed', /^Git could not read what the restore point says of its bytes/, 'oldcap, a rewind to an older row whose list of .gitattributes files passes the capped runner\'s limit');
        A.ok(cut.includes('diff-tree'), 'oldcap: that listing passed the limit (' + JSON.stringify(cut) + ')');
      });
      for (const [aid, attrs] of [['oldc', ''], ['oldc2', '*.png binary\n*.jpg -text\n*.txt !eol -filter !text\n*.md diff=markdown\n# text eol=crlf in a comment\n']]) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid), mixed = 'one\r\ntwo\n';
        if (attrs) put(path.join(wt, '.gitattributes'), attrs);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'a.txt'), mixed);
        const t = await older(aid, wt, 'T, under no pin');
        A.eq(await blobIn(aid, t, 'a.txt'), mixed, 'fixture (' + aid + '): nothing converted the older row\'s blob');
        put(path.join(wt, 'a.txt'), 'edited\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await older(aid, wt, 'S1, under no pin');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid, r } = await twoCalls(store, aid, wt, t, aid + ', a rewind to a row an older store wrote' + (attrs ? ', under rules that convert nothing' : ', no rule anywhere'));
        A.eq([mid['a.txt'], !!(r && r.preRestoreId) && /starnet: every file stored as it is/.test(await gitRun(['--git-dir', gitDirOf(aid), 'cat-file', 'commit', String(r.preRestoreId)]))], [mixed, true], aid + ': the rewound file is T\'s bytes, and the undo row says it stores them as they are');
      });
      row('olds', async ({ twoCalls }) => {
        const aid = 'olds', wt = path.join(ROOT, aid);
        put(path.join(wt, '.gitattributes'), '* text=auto\n');
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await older(aid, wt, 'T, under no pin');
        const s = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S: nothing changed since' });
        A.eq([!!(s && s.created), !!s && String(s.id) !== t], [true, true], 'olds: the first capture on an older head with nothing changed gets a row of its own');
        const again = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: nothing changed since' });
        A.eq([!!again && again.created, !!again && again.id], [false, s && s.id], 'olds: and the next unchanged capture dedups onto it');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await twoCalls(store, aid, wt, s.id, 'olds, a rewind to that row, under a text=auto rule');
      });
    }
    {
      // HOOKS IN CONFIG (the correctness MAJOR). Git 2.54's hook.<name>.event and hook.<name>.command are not core.hooksPath's: ghc, one that writes in the
      // work tree on every event ghk's did: the rewind answered ok:true with that file there, and its undo git_failed ("could not be removed").
      // ghv: one that vetoes every commit, which refused every capture. ghd: a name holding a dot. Each is switched off by name now. ghi: on a brand new shadow
      // repo its init ran one too (reference-transaction), and ghr: on the size ceiling's fresh repo, an explicit pass as a snapshot's. gheq: a name holding '=', which -c cannot say: no capture and no rewind while it stands, and health says why.
      // ghe (undo review 9's correctness MAJOR): the name "" ([hook ""], the keys hook..event and hook..command), which the store's reading of the
      // keys skipped: it ran on the shadow repo, the rewind answered ok:true with its file there and the undo git_failed. -c hook..enabled=false switches it off.
      // Each row needs a Git that knows such hooks, and lists this one by its name (`git hook list`: a line per hook); on an older one they are no hooks at all
      const hookText = (name, command) => ['pre-commit', 'post-commit', 'post-index-change', 'reference-transaction'].reduce((acc, e) => acc + '\tevent = ' + e + '\n', '[hook "' + name + '"]\n') + '\tcommand = ' + command + '\n';
      const knowsHooks = async (aid, file, name) => {
        const repo = path.join(BASE, aid + '-known');
        fs.mkdirSync(repo, { recursive: true });
        await gitRun(['init', '-q'], { cwd: repo });
        const known = spawnSync('git', ['hook', 'list', 'pre-commit'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: file }) });
        if (known.status === 0 && String(known.stdout).split(/\r?\n/).slice(0, -1).includes(name)) return true;
        console.log('[skip] ' + aid + ': this Git knows no hooks in config');
        return false;
      };
      for (const [aid, name, command] of [['ghc', 'mine', 'echo hooked >> hook-wrote-this.txt'], ['ghv', 'veto', 'exit 1'], ['ghd', 'my.hook', 'echo hooked >> hook-wrote-this.txt'],
        ['ghe', '', 'echo hooked >> hook-wrote-this.txt']]) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid), file = configFile(aid, hookText(name, command));
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (!await knowsHooks(aid, file, name)) return;
        const st = storeOver(withGlobal(file));
        const { mid } = await twoCalls(st, aid, wt, t.id, aid + ', a rewind under a hook in the person\'s config');
        A.eq(Object.keys(mid).sort(), ['app.js'], aid + ': no hook of the person\'s ran on the shadow repo');
        const s = await st.snapshot(aid, { runId: 'r', turn: 2, label: 'S2' });
        A.eq([!!s, fs.existsSync(path.join(wt, 'hook-wrote-this.txt'))], [true, false], aid + ': nor on a plain snapshot');
      });
      row('ghi', async () => {
        const aid = 'ghi', wt = path.join(ROOT, aid), file = configFile(aid, hookText('mine', 'echo hooked >> hook-wrote-this.txt'));
        put(path.join(wt, 'app.js'), 'v0\n');
        if (!await knowsHooks(aid, file, 'mine')) return;
        const st = storeOver(withGlobal(file));
        const s = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'the first capture of a new shadow repo' });
        A.eq([!!(s && s.created), fs.existsSync(path.join(wt, 'hook-wrote-this.txt'))], [true, false], 'ghi: the capture is taken, and no hook of the person\'s ran on the new shadow repo');
      });
      row('ghr', async () => {
        const aid = 'ghr', wt = path.join(ROOT, aid), file = configFile(aid, hookText('mine', 'echo hooked >> hook-wrote-this.txt'));
        put(path.join(wt, 'app.js'), 'v0\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        if (!await knowsHooks(aid, file, 'mine')) return;
        const m = await storeOver(withGlobal(file), { maxRepoBytes: 1 }).enforceSizeCeiling(aid);
        A.eq([!!(m && m.reinit), fs.existsSync(path.join(wt, 'hook-wrote-this.txt'))], [true, false], 'ghr: the size ceiling\'s pass re-inits, and no hook of the person\'s ran on either repo (' + JSON.stringify(m) + ')');
      });
      row('gheq', async ({ refusedClean }) => {
        const aid = 'gheq', wt = path.join(ROOT, aid), st = storeOver(withGlobal(configFile(aid, hookText('a=b', 'echo hooked >> hook-wrote-this.txt'))));
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        A.eq(await st.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' }), null, 'gheq: a capture under a hook -c cannot name is skipped');
        A.ok(/as its name holds "="/.test(st.health(aid).lastFailure.reason), 'gheq: and health says why (' + JSON.stringify(st.health(aid).lastFailure) + ')');
        await refusedClean(st, aid, wt, t.id, 'pre_restore_failed', /as its name holds "="/, 'gheq, a rewind under a hook -c cannot name');
      });
    }
    // ================= undo review 9: a folder that reads case apart =================
    {
      // A FOLDER THAT READS CASE APART (the two security BLOCKERS). Windows reads names in another case apart in a folder marked case-sensitive,
      // as WSL marks every folder it makes on /mnt/c and fsutil marks one with no administrator rights, while the shadow repo's core.ignorecase
      // reads two names in A-Z case apart as one and Git opens `.gitignore` by its exact name. cs5: T's cs/.GITIGNORE names build, which Git
      // never reads there: the rewind kept the person's untracked cs/build out of its capture by T's rule, the undo's walk read that rule as
      // the person's, Git did not, and the undo's capture took cs/build/out.txt and its reset deleted it, ok:true on both calls (since c8e20497).
      // csa: beside the captured cs/a.txt, the person's cs/A.txt was in no capture (`add -A` never adds it, `ls-files -o` never lists it): the
      // rewind deleted a.txt and its undo A.txt. csb: a capture of the person's cs/A.txt beside an 8-byte cs/a.txt stored its first 8 bytes
      // (Git for Windows' fscache), and both calls brought those back. cs2: T's FILE cs over such a folder: A.txt in no row. csl: cs5's loss in a
      // folder whose names hold no letter A-Z, which no name can ask. Refused now: two such names skip a capture and refuse a rewind (csa csb
      // cs2), and so does every folder that reads case apart that the checks list (cs5, and csw: one the rewind never touches), unless the reset
      // empties it (cs6); so does a rewind that writes a name with a letter A-Z into a folder holding names with none, or leaves one so (csl, and
      // csl2 in a folder that folds: its undo, writing readme.md back beside 1, could not ask that folder and would refuse on every try; csr, a
      // case-only rename there, goes ahead). cse csm: the controls an asking of the folders alone stranded: an empty folder that reads case apart,
      // which the rewind writes into, is one its undo empties, so all three calls go ahead. csn: a clone made in such a folder, two names in A-Z
      // case apart in it, which neither Git nor a rewind reads into: captured and rewound past. The folders are made with fsutil: Windows only
      const PERSON = 'the person\'s own A.txt, in no restore point\n';
      const caseApart = (aid, dir) => {
        if (!isWin) { console.log('[skip] ' + aid + ': a folder that reads case apart is made here with Windows\' fsutil'); return false; }
        fs.mkdirSync(dir, { recursive: true });
        spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { encoding: 'utf8', windowsHide: true });
        const asked = spawnSync('fsutil.exe', ['file', 'queryCaseSensitiveInfo', dir], { encoding: 'utf8', windowsHide: true });
        if (/ is enabled/.test(String(asked.stdout || ''))) return true;
        console.log('[skip] ' + aid + ': this volume gives no folder case sensitivity (' + String(asked.stdout || asked.stderr || '').trim().slice(0, 120) + ')');
        return false;
      };
      const apartRe = /^"cs" reads names in another case apart \("cs\/[^"]+" is there and "cs\/[^"]+" is not: a case-sensitive folder/;
      const twinsRe = /stand side by side in a folder that reads case apart, and Git reads them as one name/;
      const lettersRe = /holds names with no letter A-Z on one side of this rewind and a name with one on the other/;
      const healthOf = (st, aid) => { const h = st.health(aid); return (h && h.lastFailure && h.lastFailure.reason) || ''; };
      row('cs5', async ({ refusedClean }) => {
        const aid = 'cs5', wt = path.join(ROOT, aid);
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'cs', 'a.txt'), 'a\n');
        put(path.join(wt, 'cs', '.GITIGNORE'), 'build\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: cs/.GITIGNORE names build' });
        put(path.join(wt, 'cs', 'build', 'probe.txt'), 'probe\n');
        put(path.join(wt, 'plain', '.GITIGNORE'), 'build\n');
        put(path.join(wt, 'plain', 'build', 'probe.txt'), 'probe\n');
        A.eq([(await gitIn(aid, ['check-ignore', '--no-index', '-q', 'cs/build/probe.txt'])).code, (await gitIn(aid, ['check-ignore', '--no-index', '-q', 'plain/build/probe.txt'])).code],
          [1, 0], 'fixture (cs5): Git reads no .GITIGNORE in the folder that reads case apart (check-ignore --no-index names nothing for cs/build), and reads one in a folder that folds');
        fs.rmSync(path.join(wt, 'plain'), { recursive: true });
        fs.rmSync(path.join(wt, 'cs', 'build'), { recursive: true });
        fs.unlinkSync(path.join(wt, 'cs', '.GITIGNORE'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no rule file' });
        put(path.join(wt, 'cs', 'build', 'out.txt'), 'the person\'s build output, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apartRe, 'cs5, a rewind that writes T\'s .GITIGNORE into a folder that reads case apart, the person\'s untracked cs/build/out.txt in it');
      });
      row('cs6', async ({ twoCalls }) => {
        const aid = 'cs6', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', '.GITIGNORE'), 'build\n');
        put(path.join(wt, 'cs', 'build', 'out.txt'), 'the person\'s build output, no snapshot took this\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        const { r } = await twoCalls(store, aid, wt, t.id, 'cs6, a rewind that empties a folder that reads case apart (the person\'s .GITIGNORE in it, which Git never reads there)');
        A.eq((await tree(aid, r.preRestoreId)).sort(), ['app.js', 'cs/.GITIGNORE', 'cs/build/out.txt'], 'cs6: its undo row holds every file of that folder');
      });
      row('csa', async ({ refusedClean }) => {
        const aid = 'csa', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: before cs/' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', 'a.txt'), 'small a, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs/a.txt' });
        put(path.join(wt, 'cs', 'A.txt'), PERSON);
        put(path.join(wt, 'app.js'), 'v2\n');
        A.eq([!!(s1 && s1.created), (await gitIn(aid, ['ls-files', '-z', '--', 'cs'])).out, (await gitIn(aid, ['ls-files', '-z', '-o', '--', 'cs'])).out], [true, 'cs/a.txt\0', ''],
          'fixture (csa): the shadow index tracks cs/a.txt, and Git lists no cs/A.txt beside it (core.ignorecase reads it as the tracked one)');
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: after the person wrote cs/A.txt' });
        A.eq(s2, null, 'csa: a capture while cs/a.txt and cs/A.txt stand side by side is skipped (' + JSON.stringify(s2) + ')');
        A.ok(twinsRe.test(healthOf(store, aid)), 'csa: and health says why (' + JSON.stringify(healthOf(store, aid)) + ')');
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', twinsRe, 'csa, a rewind to a point before cs/, two names Git reads as one standing in it');
      });
      row('csb', async ({ refusedClean }) => {
        const aid = 'csb', wt = path.join(ROOT, aid);
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'cs', 'A.txt'), 'T: capital A\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: cs/A.txt' });
        put(path.join(wt, 'cs', 'a.txt'), 'small a\n');
        put(path.join(wt, 'cs', 'A.txt'), PERSON);
        put(path.join(wt, 'app.js'), 'v1\n');
        A.eq(fs.readdirSync(path.join(wt, 'cs')).sort(), ['A.txt', 'a.txt'], 'fixture (csb): cs holds A.txt and a.txt side by side');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the person\'s cs/A.txt beside cs/a.txt' });
        A.eq(s1, null, 'csb: a capture of the person\'s cs/A.txt beside cs/a.txt is skipped, not stored at the twin\'s length (' + JSON.stringify(s1) + ')');
        A.ok(twinsRe.test(healthOf(store, aid)), 'csb: and health says why (' + JSON.stringify(healthOf(store, aid)) + ')');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', twinsRe, 'csb, a rewind to T, the two standing side by side');
      });
      row('cs2', async ({ refusedClean }) => {
        const aid = 'cs2', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'cs'), 'T: cs is a FILE\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE cs' });
        fs.unlinkSync(path.join(wt, 'cs'));
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', 'a.txt'), 'small a\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs/a.txt' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes('cs/a.txt'), 'fixture (cs2): S1 holds cs/a.txt');
        put(path.join(wt, 'cs', 'A.txt'), PERSON);
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', twinsRe, 'cs2, a rewind that replaces such a folder with T\'s FILE cs');
      });
      row('csl', async ({ refusedClean }) => {
        const aid = 'csl', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'cs', 'a.txt'), 'T a\n');
        put(path.join(wt, 'cs', '.GITIGNORE'), '1\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: cs/.GITIGNORE names 1' });
        fs.rmSync(path.join(wt, 'cs'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', '1', '2'), 'the person\'s, in no restore point\n');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', lettersRe, 'csl, a rewind that writes T\'s a.txt and .GITIGNORE into a folder that reads case apart and holds only 1/2');
      });
      row('csl2', async ({ twoCalls, refusedClean }) => {
        const aid = 'csl2', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'd', '1'), 'T one\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: d/1' });
        put(path.join(wt, 'd', 'readme.md'), 'S1 readme\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: d/1 and d/readme.md' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (!foldsCase) { await twoCalls(store, aid, wt, t.id, 'csl2, where the file system reads every name as spelled'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"d" holds names with no letter A-Z on one side of this rewind/, 'csl2, a rewind that would leave d holding only 1');
      });
      // csr, csl2's control: T's README.md for the person's readme.md beside d/1, a case-only rename the reset deletes and writes again: d keeps a name with a letter
      row('csr', async ({ twoCalls }) => {
        const aid = 'csr', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'd', '1'), 'T one\n');
        put(path.join(wt, 'd', 'README.md'), 'T readme\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: d/1 and d/README.md' });
        fs.unlinkSync(path.join(wt, 'd', 'README.md'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S0: d/1 alone' });
        put(path.join(wt, 'd', 'readme.md'), 'S1 readme, respelled\n');
        put(path.join(wt, 'app.js'), 'v2\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: d/1 and d/readme.md' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes('d/readme.md') && !(await tree(aid, s1.id)).includes('d/README.md'), 'fixture (csr): S1 holds d/readme.md in its own spelling');
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await twoCalls(store, aid, wt, t.id, 'csr, a rewind that respells d/readme.md as T\'s README.md beside d/1');
      });
      row('csw', async ({ refusedClean }) => {
        const aid = 'csw', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', 'run.sh'), 'echo\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apartRe, 'csw, a rewind beside a folder that reads case apart, which it never touches');
      });
      for (const [aid, files] of [['cse', { '.GITIGNORE': 'build\n', 'a.txt': 'T a\n', 'sub/b.txt': 'T b\n' }], ['csm', { '1/a.txt': 'T a\n' }]]) row(aid, async ({ twoCalls }) => {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        for (const [rel, body] of Object.entries(files)) put(path.join(wt, 'cs', rel), body);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: cs' });
        fs.rmSync(path.join(wt, 'cs'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const { mid, u } = await twoCalls(store, aid, wt, t.id, aid + ', a rewind that writes T\'s cs into an empty folder that reads case apart');
        A.eq(Object.keys(files).map((rel) => mid['cs/' + rel]), Object.values(files), aid + ': the rewind wrote T\'s files');
        const third = await store.restoreDetailed(aid, (u && u.preRestoreId) || '');
        A.eq([third && third.ok, listing(wt)], [true, mid], aid + ': and restoreDetailed(the undo\'s own preRestoreId) brings the rewound tree back');
      });
      row('csn', async ({ twoCalls }) => {
        const aid = 'csn', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        if (!caseApart(aid, path.join(wt, 'lib'))) return;
        await clone(path.join(wt, 'lib'), { 'm.txt': 'module\n', 'M.txt': 'Module, beside m.txt in the clone\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone at lib, m.txt and M.txt in it' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tlib$/m.test(await treeRecs(aid, t.id)), 'fixture (csn): T is taken, two names in A-Z case apart inside the clone, and records the clone lib as a gitlink');
        put(path.join(wt, 'lib', 'm.txt'), 'module, an uncommitted edit\n');
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        await twoCalls(store, aid, wt, t.id, 'csn, a rewind beside a clone made in a folder that reads case apart');
      });
    }
    // the rows' Git reads no attributes file or global config of the person's, wherever this box keeps one (the older rows ask of both); a config row gives its own
    process.env.XDG_CONFIG_HOME = path.join(BASE, 'no-config-home');
    process.env.GIT_CONFIG_GLOBAL = path.join(BASE, 'no-gitconfig');
    await runRows(rows, rowKit);
    {
      // oldxdg, alone: the store asks this process's environment for the file Git reads when core.attributesFile is not set, as Git does
      const aid = 'oldxdg', wt = path.join(ROOT, aid), home = path.join(BASE, 'config-home');
      put(path.join(wt, 'app.js'), 'v0\n');
      fs.mkdirSync(gitDirOf(aid), { recursive: true });
      await gitRun(shadowOf(aid).concat(['init', '-q']), { cwd: wt });
      await gitRun(shadowOf(aid).concat(['add', '-A']), { cwd: wt });
      await gitRun(shadowOf(aid).concat(['commit', '-q', '-m', 'T, under no pin']), { cwd: wt });
      const t = (await gitRun(['--git-dir', gitDirOf(aid), 'rev-parse', 'HEAD'])).trim();
      put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
      put(path.join(home, 'git', 'attributes'), '*.doc diff=astextplain\n');
      process.env.XDG_CONFIG_HOME = home;
      await store.listResilient(aid);
      await rowKit().twoCalls(store, aid, wt, t, 'oldxdg\'s control, the attributes file Git reads by default converting nothing');
      put(path.join(home, 'git', 'attributes'), '* text=auto\n');
      await rowKit().refusedClean(store, aid, wt, t, 'uncaptured_check_failed', /your Git reads an attributes file of its own/, 'oldxdg, a rewind to a row an older store wrote, under the attributes file Git reads by default');
      process.env.XDG_CONFIG_HOME = path.join(BASE, 'no-config-home');
    }
    {
      // this file runs past test/slow.list's 40 s rule, its rows four at a time (slow.list says what it takes, under what load and
      // when); listed there, a gate gives it 600 s, not 120 s. Its rows were split from test/checkpoint-undo-gitlinks.test.js so
      // that file keeps that much room too. A step of the fast gate, beside it
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-reads.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-reads.test.js'), steps('http.list').includes('test/checkpoint-undo-reads.test.js')], [true, false], 'and a step of the fast gate, not the HTTP gate');
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
  A.report('checkpoint-undo-reads.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-reads.test threw — ' + (e && e.stack || e)); process.exit(1); });
