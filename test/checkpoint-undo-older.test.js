/* node test/checkpoint-undo-older.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where the walk's fold was not the file system's,
   where a capture was the first on an older shadow repo or a rewind went to a row an older store wrote, where a Git was
   killed from outside, and where the person's config named hooks (lane checkpoint-links, undo review 8, 2026-11-02;
   sidecar/checkpoint-store.js, the header's THE PROMISE and restore's THE UNDO ROW RESTORES THROUGH THIS API). These rows
   were test/checkpoint-undo-reads.test.js's until undo review 12 measured that file at 318.4 s at 80% CPU, past the lane's
   300 s a step: they moved here as they stood, so each step keeps its room under test/slow.list's 600 s.

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
     ghc ghv ghd ghi ghr gheq  Git 2.54's hooks in config ran on the shadow repo past core.hooksPath (and ghe, undo review 9's: the name "").
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The rows run eight at a time (runRows): each owns its agent id, work tree, outside folders and its capped
   runner's list of cut-off listings, so none reads another's state or timing, and one that throws fails alone; oldxdg runs
   alone after them, as it sets this process's XDG_CONFIG_HOME. kcap and oldcap use the real runner capped at
   1500 bytes; the config rows give the real runner a spawn that sets GIT_CONFIG_GLOBAL for its own Git
   alone, and the kill rows one that kills a real Git right after its start (process.kill: TerminateProcess(h, 1) on Windows,
   what taskkill /F gives; a signal elsewhere, which fails closed too). atbig and atbig2 alone answer for the runner: a
   timeout for a whole-tree hash while Git's own index shows no stat data; kl5 cuts a real answer off in its last line;
   oldsys and uafs answer one read of the file system. Every row runs against a real temp work tree and real git
   (test/helpers/checkpoint-rows.js says how the rows run and how Git is started); the rows' Git reads no global config or
   attributes file of the person's (a config row gives its own).
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), junctions (Windows) or directory
   symlinks (POSIX) to folders outside the work tree, all inside this test's own os.tmpdir() folder; a link is removed with
   `cmd /c rmdir` (Windows) / unlink before the folder is deleted. */
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

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-older-')));
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
    const outsideOf = (aid) => {
      const out = path.join(BASE, aid + '-outside');
      put(path.join(out, 'x.txt'), 'OUTSIDE x: no part of this work tree\n');
      put(path.join(out, 'other.txt'), 'OUTSIDE other\n');
      put(path.join(out, 'deep', 'y.txt'), 'OUTSIDE y\n');
      return out;
    };
    const noFold = (aid) => { if (foldsCase) return false; console.log('[skip] ' + aid + ': this file system does not fold case'); return true; };
    const apart = /are spelled apart in a letter outside A-Z, which Git reads as two names and the file system may read as one/;
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
      // this file runs past test/slow.list's 40 s rule, its rows eight at a time (slow.list says what it takes, under what load and
      // when); listed there, a gate gives it 600 s, not 120 s. Its rows were split from test/checkpoint-undo-reads.test.js at undo review 12 so
      // that file keeps that much room too. A step of the fast gate, beside it
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-older.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-older.test.js'), steps('http.list').includes('test/checkpoint-undo-older.test.js')], [true, false], 'and a step of the fast gate, not the HTTP gate');
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
  A.report('checkpoint-undo-older.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-older.test threw — ' + (e && e.stack || e)); process.exit(1); });
