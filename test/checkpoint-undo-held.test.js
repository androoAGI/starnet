/* node test/checkpoint-undo-held.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where another program holds a file or a folder
   the reset would touch or runs from one, and where a capture or a listing of the rewind's took what its undo could not
   (lane checkpoint-links, undo reviews 11 and 12, 2026-11-02 and 2026-11-03; sidecar/checkpoint-store.js, the header's THE
   PROMISE, restore's THE UNDO ROW RESTORES THROUGH THIS API and A REMOVAL RESET COULD NOT DO, foldedTwoRefusal's WHAT GIT LEAVES
   and IN USE, prepareCapture's TWO NAMES GIT READS AS ONE, inUse and namesBothWays). Undo review 11's rows of what Git leaves
   and of a reset that stops partway moved here from test/checkpoint-undo-case.test.js at undo review 12, as they stood but for
   the words a refusal names a running program with, and for hpc, hp7 and hp8 (below); its other rows are
   test/checkpoint-undo-folders.test.js's, so each of the three steps keeps its room under test/slow.list's 600 s.

   Undo review 11 found, at d7247072 (the block below says more):
     sro2 sro3  a folder the reset emptied that Git left standing (read-only, or another program's working folder): the undo, writing into it through another spelling
           or with a gitlink's empty folder, was refused on every try, the person's edit in its row only (sro3 a regression of d80dabc5); sro1 the control;
     hp1 hp2 hp6 hca hcd  a file another program holds open in a folder the reset was to empty, or, in hcd, a folder below it that is another program's working folder: left
           there, the folder's undo met what UNASKED, LETTERS or the case-apart exception refuse (hp1 a regression of d80dabc5, the rest open since 69668e6e). Refused now;
     st1-st4  a reset stopped partway: Git only warns of a file it cannot delete but stops at a FILE it cannot make a folder of or a folder it cannot write a FILE at,
           the writes after that path not done, so a folder lost its name with a letter and never got the one to come. Asked before the commit now.
   Undo review 12 found, at 551bca25 (each fails there and passes here unless it says otherwise; the block below says more):
     tws twe  csb's twins through a rewind: its capture ran `add -A` before the refusal, Git for Windows' fscache gave cs/A.txt its twin's stat and length, and once
           the person moved A.txt aside, as the refusal says, the next capture committed those bytes for cs/A.txt, the twin's own in no row. A capture is
           refused before its `add` now while such twins stand;
     rw1 rw2  undo review 11's listing of what the reset writes over, split on the tree the capture staged only (a regression of 551bca25): the rewind went
           ahead, and its undo, splitting it on the target's, was refused on every try. Split on both now; rw3 the control;
     x1 x2 x3  a program running from the workspace: no handle holds its own .exe, so STOPS and HELD read it as free, and Git stopped partway (x1, x2) or
           left it (x3), the undo refused on every try (d7247072 the same). A file is opened for writing too now, which the program's image refuses; x4
           the same read-only, which that open cannot ask, so a read-only program's image counts as in use; xro the control, a read-only file Git deletes;
     hw1 hg1 hg2  a held file the reset writes over: Git exits 128 with its index unwritten, and the undo met a case-only rename as SPELLED (hw1, a regression of
           551bca25) or the target's own folder as what no capture took (hg1, hg2), on every try;
     hl1 hl2  a held file the reset deletes, which a plain rule of the target names once the reset writes it: the undo took it for what no capture took, on every
           try. Every file the reset deletes or writes over is asked now (IN USE);
     hpc hp7 hp8  undo review 11's controls, a held file the reset deletes: refused now while it is held; a program that opens it after the checks, just before
           the reset, still leaves git_failed with an undo row that restores every path and byte (each passes at 551bca25 but for that refusal);
     n1 r0 e1 tw2  what no row pinned (each passes at 551bca25 too): four clauses undo review 12 took out one at a time, every lane file passing each time.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The rows run eight at a time (runRows): each owns its agent id, work tree and its capped runner's list of
   cut-off listings, so none reads another's state or timing, and one that throws fails alone. rw1, rw2 and rw3 use the
   real runner capped at 1500 bytes. Every row runs against a real temp work tree and real git (test/helpers/checkpoint-rows.js says how
   the rows run and how Git is started); the rows' Git reads no global config or attributes file of the person's.
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), all inside this test's own os.tmpdir() folder. A folder
   that reads case apart is made with `fsutil file setCaseSensitiveInfo <folder> enable` (no administrator rights needed), and fsutil itself
   is asked that it does; where it cannot, the row says so and is skipped. A folder is made read-only with `attrib +R`, a file held open by a
   PowerShell with FileShare.Read (or, just before a reset, by this file's own process, sharing nothing), a folder held as a working folder by
   that PowerShell's own, a program run from the workspace a copy of Windows' own PING.EXE (each let go in the row's `finally`, Windows only, as
   the other rows' fixtures are). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-held-')));
const ROOT = path.join(BASE, 'ws');
function put(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
// every file below dir with its bytes, by path, sorted
function listing(dir) {
  const out = {};
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
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
// the bytes the restore point `id` holds at `p` (a fixture's own read of what a capture stored), or null when it holds none there
async function blobOf(aid, id, p) {
  try { return await gitRun(['--git-dir', gitDirOf(aid), 'cat-file', 'blob', String(id).split(':').pop() + ':' + p]); } catch (_) { return null; }
}

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
    {
      // ================= undo review 11: what Git leaves (moved from test/checkpoint-undo-case.test.js at undo review 12) =================
      // WHAT GIT LEAVES (security BLOCKERS 1 and 2). Git for Windows leaves a file another program holds open without delete sharing (it warns: the
      // rewind answers git_failed with its undo row) and a folder that is another program's working folder or read-only (its rmdir clears no
      // attribute: the rewind answers ok, that folder standing empty). Each rule that rested on Git removing a folder then refused the undo on every
      // try, the hold gone or not: sro2, a folder renamed Src to src since S1 (the index keeps Src), read-only, which its undo wrote into through Src;
      // sro3, a read-only folder holding a gitlink's empty folder; hp1 (UNASKED), hp2 and hp6 (LETTERS), a folder holding a name with no letter A-Z,
      // what Git left there held open; hca (CASE APART's exception), a folder that reads case apart, b.txt held open, and hcd, its folder sub
      // another program's working folder. Refused now: a folder that must go holding a name with no letter A-Z, unless that is all it holds and is a
      // file or a folder that goes too (PARTIAL: hp1, hp2, hp6, csz), a tree's spelling that is not the disk's (SPELLED: sro2), a gitlink's empty folder in
      // one (STANDING: sro3), and a folder that reads case apart, where a file or folder below it is in use (HELD: hca, hcd). sro1, hpc, hp7, hp8: the
      // controls, a read-only folder the undo writes into, and a held file where its undo has no folder to ask, git_failed and undone (since undo review
      // 12 hpc, hp7 and hp8 are refused while the file is held, and pin the git_failed undo where a program opens it after the checks: below).
      // A RESET THAT STOPS (STOPS): Git only warns of a file it cannot delete, but stops at a FILE it cannot make a folder of or a folder it cannot write a
      // FILE at, every deletion done and the writes after that path not, so zz, which held 1 and a.txt on one side and 1 and b.txt on the other, was left
      // holding 1 alone and its undo refused on every try: st1 a FILE held open, st2 a file held open in the folder, st3 that folder read-only, st4 an empty
      // folder read-only.
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
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // a file's time set well before now: past Git's racy window with no pause, so the capture after a rename keeps the index's spelling
      const settle = (file) => fs.utimesSync(file, 1600000000, 1600000000);
      // T's files, then S1's in their place, each taken by a snapshot, and an edit no capture took
      const twoTrees = async (aid, wt, tFiles, sFiles, settled) => {
        for (const [rel, body] of Object.entries(tFiles)) put(path.join(wt, rel), body);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: ' + Object.keys(tFiles).join(', ') });
        for (const e of fs.readdirSync(wt)) fs.rmSync(path.join(wt, e), { recursive: true, force: true });
        for (const [rel, body] of Object.entries(sFiles)) {
          put(path.join(wt, rel), body);
          if (settled) settle(path.join(wt, rel));
        }
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: ' + Object.keys(sFiles).join(', ') });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        return t;
      };
      // these rows pin what only a file system that folds case asks, so on any other they add Git calls and no check
      const foldOnly = (aid) => { if (foldsCase) return true; console.log('[skip] ' + aid + ': this file system does not fold case'); return false; };
      const holdSkip = (aid) => { if (isWin) return true; console.log('[skip] ' + aid + ': a file is held open, a folder held or made read-only, here with Windows\' PowerShell and attrib'); return false; };
      // a program holding a file open, FileShare.Read (no delete sharing), or with a folder as its working folder, until letGo
      const powershell = (command, cwd) => new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command + "; [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 300"], { cwd: cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        const late = setTimeout(() => { child.kill(); reject(new Error('the hold did not start: ' + out)); }, 60000);
        child.stdout.on('data', (b) => { out += b; if (/held/.test(out)) { clearTimeout(late); resolve(child); } });
        child.on('error', (e) => { clearTimeout(late); reject(e); });
      });
      const holdOpen = (file) => powershell("$f = [System.IO.File]::Open('" + file.replace(/'/g, "''") + "', 'Open', 'Read', 'Read')", BASE);
      const holdAsCwd = (dir) => powershell('$null = 1', dir);
      const letGo = (child) => new Promise((resolve) => { if (!child || child.exitCode != null || child.signalCode) { resolve(); return; } child.once('exit', () => resolve()); child.kill(); });
      const readOnly = (dir, on) => execFileSync('cmd', ['/c', 'attrib', on ? '+R' : '-R', dir], { windowsHide: true, stdio: 'ignore' });
      const partialRe = (name, dir) => new RegExp('^"' + name + '" has no letter A-Z in its name, and rewinding would empty "' + dir + '", which holds it: were Git to leave something in that folder');
      // the refusals that name what is in use: a FILE Git would stop at, or a folder holding it (STOPS); one in a folder that reads case apart (HELD); a file
      // the reset deletes or writes over (IN USE)
      const inUseAs = 'is in use \\(open in another program, a program running from it, another program\'s working folder, or read-only\\)';
      const inUseRe = (name) => new RegExp('^"' + name.replace('.', '\\.') + '" ' + inUseAs + ', and rewinding would replace ');
      const heldRe = (name) => new RegExp('^"' + name.replace('.', '\\.') + '" ' + inUseAs + ', in "cs", a folder that reads names in another case apart');
      const inUseFileRe = (name, over) => new RegExp('^"' + name.replace(/\./g, '\\.') + '" is in use \\(open in another program, a program running from it, or a read-only program file\\), and rewinding would ' + (over ? 'write over it' : 'delete it'));
      // the rows' store through the real runner, its output limit 1500 bytes; `cut` names the Git verbs it cut off
      const cappedStore = (cut) => makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
      const zzT = { 'zz/1': 'T one\n', 'zz/b.txt': 'T b\n' }, zzS = { 'zz/1': 'S1 one\n', 'zz/a.txt': 'S1 a\n' };
      row('sro1', async () => {
        const aid = 'sro1', wt = path.join(ROOT, aid), data = path.join(wt, 'data');
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no data' });
        put(path.join(data, 'a.txt'), 'the person\'s a\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/a.txt' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const before = listing(wt);
        readOnly(data, true);
        try {
          const r = await store.restoreDetailed(aid, t.id);
          A.eq([r && r.ok, fs.existsSync(data) && fs.readdirSync(data).length], [true, 0], 'sro1: the rewind goes ahead, and Git leaves the read-only folder data standing, holding nothing (' + JSON.stringify(r) + ')');
          const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
          A.eq([u && u.ok, listing(wt)], [true, before], 'sro1: restoreDetailed(the rewind\'s preRestoreId) writes into that folder, and every path and byte is back (' + JSON.stringify(u) + ')');
        } finally { readOnly(data, false); }
      });
      row('sro2', async ({ refusedClean }) => {
        const aid = 'sro2', wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no Src' });
        put(path.join(wt, 'Src', 'x.txt'), 'the person\'s x\n');
        settle(path.join(wt, 'Src', 'x.txt'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: Src/x.txt' });
        fs.renameSync(path.join(wt, 'Src'), path.join(wt, 'src'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        A.eq((await gitIn(aid, ['ls-files', '-z'])).out.split('\0').filter(Boolean).sort(), ['Src/x.txt', 'app.js'], 'fixture (sro2): the shadow index keeps Src/x.txt, as S1 spelled it');
        readOnly(path.join(wt, 'src'), true);
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"src\/x\.txt" is spelled "Src\/x\.txt" in what rewinding would save as its undo/, 'sro2, a rewind that empties the read-only folder src, renamed from Src since S1'); }
        finally { readOnly(path.join(wt, 'src'), false); }
      });
      row('sro3', async ({ refusedClean }) => {
        const aid = 'sro3', wt = path.join(ROOT, aid), data = path.join(wt, 'data');
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no data' });
        put(path.join(data, 'a.txt'), 'the person\'s a\n');
        await clone(path.join(data, 'sub'), { 'm.txt': 'module\n' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/a.txt and the clone data/sub' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tdata\/sub$/m.test(await treeRecs(aid, s1.id)), 'fixture (sro3): S1 records the clone data/sub as a gitlink');
        fs.rmSync(path.join(data, 'sub'), { recursive: true, force: true });
        fs.mkdirSync(path.join(data, 'sub'));               // the clone gone, its empty folder left
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        readOnly(data, true);
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^rewinding would remove "data", where what it would save as its undo records an embedded repository \(a gitlink\)/, 'sro3, a rewind that empties the read-only folder data, a gitlink\'s empty folder in it'); }
        finally { readOnly(data, false); }
      });
      for (const [aid, files, held, re] of [
        ['hp1', { 'data/1': 'one\n', 'data/2': 'two\n' }, 'data/1', partialRe('data/1', 'data')],
        ['hp2', { 'data/1': 'one\n', 'data/a.txt': 'the person\'s a\n' }, 'data/1', partialRe('data/1', 'data')],
        ['hp6', { 'logs/app.log': 'app log\n', 'logs/2026/server.log': 'server log, a running server\'s\n' }, 'logs/2026/server.log', partialRe('logs/2026', 'logs')]
      ]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: none of them' });
        for (const [rel, body] of Object.entries(files)) put(path.join(wt, rel), body);
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: ' + Object.keys(files).join(', ') });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const child = await holdOpen(path.join(wt, held));
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', re, aid + ', a rewind that empties a folder holding a name with no letter A-Z, ' + held + ' held open by another program'); }
        finally { await letGo(child); }
      });
      // hpc, hp7 and hp8 were undo review 11's controls: a held file the reset was to delete, git_failed, and its undo row brought every path and byte back. A
      // held file refuses the rewind now (IN USE, undo review 12), so they pin both sides of it: refused while the file is held; and where a program opens it
      // after the checks, just before the reset (a store whose reset starts only once this process holds that file, sharing nothing), an incomplete rewind
      // whose undo row brings every path and byte back
      for (const [aid, files, held] of [
        ['hpc', { 'data/a.txt': 'the person\'s a\n', 'data/b.txt': 'the person\'s b\n' }, 'data/a.txt'],
        ['hp7', { 'data/1': 'the person\'s one\n' }, 'data/1'],
        ['hp8', { 'logs/2026/a.log': 'the person\'s a\n', 'logs/2026/b.log': 'the person\'s b\n' }, 'logs/2026/a.log']
      ]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: none of them' });
        for (const [rel, body] of Object.entries(files)) put(path.join(wt, rel), body);
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: ' + Object.keys(files).join(', ') });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await heldFor(aid, wt, held, t, refusedClean, inUseFileRe(held, false), aid + ', a rewind that removes ' + Object.keys(files).join(' and ') + ', ' + held + ' held open');
        const before = listing(wt), late = {};
        const racing = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => {
          if (args.includes('reset') && args.includes('--hard') && late.fd == null) late.fd = fs.openSync(path.join(wt, held), 0x10000000);
          return runGit(args, opts);
        } });
        let r;
        try { r = await racing.restoreDetailed(aid, t.id); } finally { if (late.fd != null) fs.closeSync(late.fd); }
        A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId), r && r.left, late.fd != null], [false, 'git_failed', true, [held], true], aid + ': a program that opens ' + held + ' after the checks, just before the reset, leaves the rewind incomplete, naming that file (' + JSON.stringify(r) + ')');
        const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
        A.eq([u && u.ok, listing(wt)], [true, before], aid + ': once the program lets go, restoreDetailed(its preRestoreId) brings every path and byte back (' + JSON.stringify(u) + ')');
      });
      for (const [aid, files, held, how] of [['hca', { 'a.txt': 'the person\'s a\n', 'b.txt': 'the person\'s b\n' }, 'b.txt', 'open'], ['hcd', { 'a.txt': 'the person\'s a\n', 'sub/x.txt': 'the person\'s x\n' }, 'sub', 'cwd']]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        for (const [rel, body] of Object.entries(files)) put(path.join(wt, 'cs', rel), body);
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const child = how === 'open' ? await holdOpen(path.join(wt, 'cs', held)) : await holdAsCwd(path.join(wt, 'cs', held));
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', new RegExp('^"cs/' + held.replace('.', '\\.') + '" is in use \\(open in another program, a program running from it, another program\'s working folder, or read-only\\), in "cs", a folder that reads names in another case apart'), aid + ', a rewind that empties a folder that reads case apart, cs/' + held + (how === 'open' ? ' held open' : ' another program\'s working folder')); }
        finally { await letGo(child); }
      });
      for (const [aid, tFiles, sFiles, at, how] of [
        ['st1', { 'aa/x.txt': 'T x\n' }, { aa: 'S1: the FILE aa\n' }, 'aa', 'open'],
        ['st2', { aa: 'T: the FILE aa\n' }, { 'aa/f.txt': 'S1 f\n' }, 'aa/f.txt', 'open'],
        ['st3', { aa: 'T: the FILE aa\n' }, { 'aa/f.txt': 'S1 f\n' }, 'aa', 'read-only'],
        ['st4', { aa: 'T: the FILE aa\n' }, {}, 'aa', 'empty']
      ]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        const t = await twoTrees(aid, wt, Object.assign({ 'app.js': 'v0\n' }, tFiles, zzT), Object.assign({ 'app.js': 'v1\n' }, sFiles, zzS));
        const held = path.join(wt, at);
        if (how === 'empty') fs.mkdirSync(held);
        const child = how === 'open' ? await holdOpen(held) : null;
        if (!child) readOnly(held, true);
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', inUseRe(at), aid + ', a rewind Git would stop partway at ' + at + ', ' + how); }
        finally { if (child) await letGo(child); else readOnly(held, false); }
      });
      // ================= undo review 12: a capture's twins, a listing split both ways, a program running from the workspace, every file the reset touches in use =================
      // TWO NAMES GIT READS AS ONE, THROUGH A REWIND (security BLOCKER 1). csb's shape (test/checkpoint-undo-case.test.js), past Git's racy window as any real gap
      // is: T holds cs/A.txt beside keep.txt in a folder that reads case apart; the person edits A.txt and writes its twin cs/a.txt, shorter (tws) or as long
      // (twe). A rewind's capture ran `add -A`, and its refusal came after it: Git for Windows' fscache answered cs/A.txt with a.txt's stat, so Git read A.txt at
      // a.txt's length and kept a.txt's stat on that entry. Refused clean, the rewind left those bytes staged; the person moved A.txt aside, as the refusal says,
      // and Git, its lstat finding a.txt through fscache with the stat it kept, trusted the entry: the next capture stored them for cs/A.txt, and a.txt's own bytes
      // were in no row (a rewind to that capture brought them back as A.txt, ok:true). Every capture is refused before its `add` now while such twins stand: the
      // index keeps T's bytes, and the capture after the move is skipped (Git cannot open cs/A.txt) or stores cs/a.txt whole
      for (const [aid, mine, other] of [['tws', PERSON, 'small a\n'], ['twe', 'AAAAAAAAAAAAAAAAAAAAAAAA\n', 'aaaaaaaaaaaaaaaaaaaaaaaa\n']]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'cs', 'A.txt'), 'T: capital A\n');
        put(path.join(wt, 'cs', 'keep.txt'), 'keep\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: cs/A.txt and cs/keep.txt' });
        put(path.join(wt, 'cs', 'a.txt'), other);
        put(path.join(wt, 'cs', 'A.txt'), mine);
        put(path.join(wt, 'app.js'), 'v1, no snapshot took this\n');
        A.eq([fs.readdirSync(path.join(wt, 'cs')).sort(), mine.length >= other.length], [['A.txt', 'a.txt', 'keep.txt'], true], 'fixture (' + aid + '): cs holds A.txt and its twin a.txt, ' + (mine.length > other.length ? 'shorter' : 'as long'));
        await pause(2200);                                  // past Git's racy window: Git trusts an entry whose stat matches
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', twinsRe, aid + ', a rewind while cs/A.txt and cs/a.txt stand side by side');
        A.eq((await gitIn(aid, ['show', ':cs/A.txt'])).out, 'T: capital A\n', aid + ': the shadow index still holds T\'s bytes for cs/A.txt, never A.txt at the twin\'s length or with its stat');
        fs.renameSync(path.join(wt, 'cs', 'A.txt'), path.join(BASE, 'aside-' + aid + '-A.txt'));   // as the refusal says: move one of them aside
        await pause(2200);
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S2: cs/A.txt moved aside, cs/a.txt standing' });
        const at = s2 ? (await tree(aid, s2.id)).filter((p) => /^cs\/a\.txt$/i.test(p)) : [];
        const bytes = at.length === 1 ? await blobOf(aid, s2.id, at[0]) : null;
        A.ok(!s2 || bytes === other, aid + ': the capture after the move is skipped, or stores cs/a.txt whole (' + JSON.stringify({ s2: s2 && s2.created, at: at, bytes: bytes }) + ')');
      });
      // A LISTING SPLIT ON ONE TREE (security BLOCKER 2, a regression of 551bca25). Undo review 11's repair lists what the reset writes over (diff-tree M) for
      // SPELLED, and split it, past the runner's output limit, on the tree the capture staged; its undo splits the same listing on the target's. rw1: T holds F
      // with 30 names of 50 characters (its entry list 1530 bytes, past the capped runner's 1500); the person deletes one and changes the other 29 (1479 bytes),
      // S1 takes that, and app.js changes since: the rewind went ahead and its undo was refused on every try, app.js v2 in its row only. rw2: the same, no capture
      // since T. Refused now, the listing split on both trees as the rewind and its undo split it (namesBothWays); rw3, F's 29 names in both, the control: both calls.
      // Where the file system does not fold case nothing asks that listing, and each goes ahead, both calls
      const nm = (i) => ('n' + String(i).padStart(4, '0')).padEnd(46, 'x') + '.txt';
      for (const [aid, inT, snapS1] of [['rw1', 30, true], ['rw2', 30, false], ['rw3', 29, true]]) row(aid, async ({ cut, twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid), gone = inT === 30 ? 1 : 0;
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < inT; i++) put(path.join(wt, 'F', nm(i)), 'T ' + i + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: F holds ' + inT + ' names of 50 characters' });
        if (gone) fs.unlinkSync(path.join(wt, 'F', nm(inT - 1)));
        for (let i = 0; i < inT - gone; i++) put(path.join(wt, 'F', nm(i)), 'the person\'s ' + i + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        if (snapS1) await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: each of them changed' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        cut.length = 0;
        const label = aid + ', a rewind that writes over ' + (inT - gone) + ' files of F, whose entry list holds ' + inT + ' names in T';
        if (!gone || !foldsCase) { await twoCalls(cappedStore(cut), aid, wt, t.id, label); return; }
        await refusedClean(cappedStore(cut), aid, wt, t.id, 'uncaptured_check_failed', /^Git could not list what rewinding would write over/, label);
        A.ok(cut.includes('diff-tree') && cut.includes('ls-tree'), aid + ': that listing and F\'s own entry list in T passed the limit (' + JSON.stringify(cut) + ')');
      });
      // A PROGRAM RUNNING FROM THE WORKSPACE (correctness BLOCKER 3). Windows maps a running program's own file as its image: no handle holds it, so the open
      // that shares nothing went through and STOPS and HELD read it as free, while Git cannot delete it. x1 (st1's shape): T's folder tool.exe where the FILE
      // tool.exe runs; x2 (st2's): T's FILE aa where the folder aa holds the running aa/tool.exe; x3 (hca's): the running cs/tool.exe in a folder that reads case
      // apart, which the rewind empties. Git stopped partway (x1, x2: zz left holding 1 alone) or left it (x3: git_failed), and the undo was refused on every try. A
      // file is opened for writing too now (inUse), which a program's image refuses; a read-only one, which that open cannot ask (Git clears the attribute itself),
      // counts as in use where it is a program's image (x4: x2's, read-only), and goes where it is not (xro, the control: both calls). The program is a copy of
      // Windows' own PING.EXE, pinging this box until the row stops it
      const EXE = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE') : '';
      const runFrom = (file) => new Promise((resolve) => {
        const child = spawn(file, ['-n', '300', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
        child.once('error', (e) => resolve({ child: null, why: (e && e.message) || String(e) }));
        child.once('spawn', () => setTimeout(() => resolve({ child: child }), 300));
      });
      // an open that shares nothing goes through while it runs: no handle holds that file (what the store asked alone before)
      const sharesNothing = (file) => { try { fs.closeSync(fs.openSync(file, 0x10000000)); return true; } catch (_) { return false; } };
      for (const [aid, run, ro] of [['x1', 'tool.exe'], ['x2', 'aa/tool.exe'], ['x3', 'cs/tool.exe'], ['x4', 'aa/tool.exe', true]]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        let t;
        if (aid === 'x3') {
          put(path.join(wt, 'app.js'), 'v0\n');
          t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no cs' });
          if (!caseApart(aid, path.join(wt, 'cs'))) return;
          put(path.join(wt, 'cs', 'a.txt'), 'the person\'s a\n');
          fs.copyFileSync(EXE, path.join(wt, 'cs', 'tool.exe'));
          put(path.join(wt, 'app.js'), 'v1\n');
          await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs/a.txt and cs/tool.exe' });
          put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        } else {
          t = await twoTrees(aid, wt, Object.assign({ 'app.js': 'v0\n' }, aid === 'x1' ? { 'tool.exe/x.txt': 'T x\n' } : { aa: 'T: the FILE aa\n' }, zzT),
            Object.assign({ 'app.js': 'v1\n', [run]: fs.readFileSync(EXE) }, zzS));
        }
        if (ro) fs.chmodSync(path.join(wt, run), 0o444);
        const { child, why } = await runFrom(path.join(wt, run));
        if (!child) { console.log('[skip] ' + aid + ': a copy of PING.EXE could not run from the workspace (' + why + ')'); return; }
        try {
          A.ok(sharesNothing(path.join(wt, run)), 'fixture (' + aid + '): an open that shares nothing goes through while ' + run + ' runs: no handle holds it');
          await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', aid === 'x3' ? heldRe('cs/tool.exe') : inUseRe(run),
            aid + ', a rewind ' + (aid === 'x3' ? 'that empties a folder that reads case apart' : 'Git would stop partway at ' + (aid === 'x1' ? 'tool.exe' : 'aa')) + ', ' + run + ' running' + (ro ? ', read-only' : ''));
        } finally {
          await letGo(child);
          if (ro) fs.chmodSync(path.join(wt, run), 0o666);
        }
      });
      row('xro', async ({ twoCalls }) => {
        const aid = 'xro', wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no notes.txt' });
        put(path.join(wt, 'notes.txt'), 'the person\'s notes, read-only\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: notes.txt' });
        fs.chmodSync(path.join(wt, 'notes.txt'), 0o444);
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        try { await twoCalls(store, aid, wt, t.id, 'xro, a rewind that deletes the read-only notes.txt, which is no program\'s image'); }
        finally { try { fs.chmodSync(path.join(wt, 'notes.txt'), 0o666); } catch (_) {} }
      });
      // A HELD FILE THE RESET WRITES OVER (correctness BLOCKER 4). Git cannot unlink it, carries on with every other path, and exits 128 with its index unwritten:
      // the shadow index as the capture staged it, the work tree the target's. hw1: csr's shape (a case-only rename between the trees), server.log held: its undo
      // met d/README.md as SPELLED on every try (a regression of 551bca25; d7247072 undid it). hg1, hg2: T tracks gen/out.js (the FILE gen) below its own rule,
      // the staged tree the FILE gen (gen/x.txt): its undo took T's folder (FILE), written and ignored, for what no capture took, on every try (d7247072 the same).
      // A HELD FILE THE RESET DELETES (correctness BLOCKER 5): Git only warns, and the rewind answered git_failed with its undo row; where T's .gitignore, now on
      // disk, names the file left, its undo took it for one no capture took, at a path its row holds, on every try (d7247072 the same): hl1 server.log, hl2
      // logs/server.log beside logs/old.log. Every file the reset deletes or writes over is asked now as STOPS asks, as late as the checks go (IN USE)
      const heldFor = async (aid, wt, file, t, refusedClean, re, label) => {
        const child = await holdOpen(path.join(wt, file));
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', re, label); } finally { await letGo(child); }
      };
      row('hw1', async ({ refusedClean }) => {
        const aid = 'hw1', wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'server.log'), 'log v0\n');
        put(path.join(wt, 'd', 'README.md'), 'T readme\n');
        put(path.join(wt, 'd', 'k.txt'), 'k\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: d/README.md and d/k.txt' });
        fs.unlinkSync(path.join(wt, 'd', 'README.md'));
        put(path.join(wt, 'server.log'), 'log v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S0: no d/README.md' });
        put(path.join(wt, 'd', 'readme.md'), 'S1 readme\n');
        put(path.join(wt, 'server.log'), 'log v2\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: d/readme.md' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes('d/readme.md'), 'fixture (hw1): S1 holds d/readme.md in its own spelling');
        put(path.join(wt, 'server.log'), 'log v3, no snapshot took this\n');
        await heldFor(aid, wt, 'server.log', t, refusedClean, inUseFileRe('server.log', true), 'hw1, a rewind that respells d/readme.md as T\'s README.md, server.log held open');
      });
      for (const [aid, folder] of [['hg1', true], ['hg2', false]]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid), mine = folder ? 'gen/out.js' : 'gen';
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'server.log'), 'log v0\n');
        put(path.join(wt, mine), folder ? 'gen out\n' : 'T: the FILE gen\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'first: ' + mine });
        put(path.join(wt, '.gitignore'), folder ? 'gen/\n' : 'gen\n');
        put(path.join(wt, 'server.log'), 'log v1\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: its .gitignore names gen, which it still tracks' });
        A.ok(!!t && (await tree(aid, t.id)).includes(mine), 'fixture (' + aid + '): T tracks ' + mine + ' below its own rule');
        fs.unlinkSync(path.join(wt, '.gitignore'));
        fs.rmSync(path.join(wt, 'gen'), { recursive: true });
        put(path.join(wt, folder ? 'gen' : 'gen/x.txt'), folder ? 'the person\'s FILE gen\n' : 'the person\'s gen/x.txt\n');
        put(path.join(wt, 'server.log'), 'log v2\n');
        await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: ' + (folder ? 'the FILE gen' : 'gen/x.txt') });
        put(path.join(wt, 'server.log'), 'log v3, no snapshot took this\n');
        await heldFor(aid, wt, 'server.log', t, refusedClean, inUseFileRe('server.log', true), aid + ', a rewind that writes T\'s ' + (folder ? 'folder' : 'FILE') + ' gen over the person\'s, server.log held open');
      });
      for (const [aid, rule, files, held] of [
        ['hl1', 'server.log', { 'server.log': 'the person\'s log\n' }, 'server.log'],
        ['hl2', 'logs', { 'logs/server.log': 'the person\'s log\n', 'logs/old.log': 'old\n' }, 'logs/server.log']
      ]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, '.gitignore'), rule + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: its .gitignore names ' + rule });
        fs.unlinkSync(path.join(wt, '.gitignore'));
        for (const [rel, body] of Object.entries(files)) put(path.join(wt, rel), body);
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no rule, ' + Object.keys(files).join(' and ') + ' captured' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes(held), 'fixture (' + aid + '): S1 holds ' + held);
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await heldFor(aid, wt, held, t, refusedClean, inUseFileRe(held, false), aid + ', a rewind that deletes ' + held + ', which T\'s .gitignore names, held open');
      });
      // WHAT NO ROW PINNED (correctness MAJOR 6). Four clauses that each keep an undo from stranding, each taken out alone by undo review 12 with every lane file
      // passing: n1, a folder whose folder the reset empties is one whose entries change (LETTERS: d left holding only 1); r0, the root left holding nothing is a
      // folder that must go (PARTIAL: 1 beside a.txt), here with its folder 1 another program's working folder, which Git leaves; e1, an empty folder in a folder
      // that reads case apart is one the reset does not empty (Git leaves it, so cs stands, reading so); tw2, two spellings of one file in a tree, not of a folder
      // alone (TWO SPELLINGS: its undo met SPELLED). Without its clause each rewind went ahead and its undo was refused on every try
      row('n1', async ({ refusedClean }) => {
        const aid = 'n1', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'd', '1'), 'one\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: d/1' });
        put(path.join(wt, 'd', 'sub', 'x.txt'), 'x\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: d/1 and d/sub/x.txt' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"d" holds names with no letter A-Z on one side of this rewind and a name with one on the other/, 'n1, a rewind that empties d/sub, leaving d holding only 1');
      });
      row('r0', async ({ refusedClean }) => {
        const aid = 'r0', wt = path.join(ROOT, aid);
        if (!holdSkip(aid)) return;
        fs.mkdirSync(wt, { recursive: true });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing' });
        A.eq([!!(t && t.created), t ? await tree(aid, t.id) : null], [true, []], 'fixture (r0): T is taken of a folder that holds nothing, an empty tree');
        put(path.join(wt, 'a.txt'), 'a\n');
        put(path.join(wt, '1', 'x.txt'), 'x\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: a.txt and 1/x.txt' });
        put(path.join(wt, 'a.txt'), 'a, no snapshot took this\n');
        const child = await holdAsCwd(path.join(wt, '1'));
        try { await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', partialRe('1', '\\.'), 'r0, a rewind to an empty tree, the folder 1 another program\'s working folder'); }
        finally { await letGo(child); }
      });
      row('e1', async ({ refusedClean }) => {
        const aid = 'e1', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', 'a.txt'), 'a\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs/a.txt' });
        fs.mkdirSync(path.join(wt, 'cs', 'e'));             // an empty folder of the person's: no capture records it, and Git leaves it
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apartRe, 'e1, a rewind that empties cs, which reads case apart, but for its empty folder e');
      });
      row('tw2', async ({ refusedClean }) => {
        const aid = 'tw2', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'x', 'a.txt'), 'T small a\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'x/a.txt' });
        const blob = (await gitIn(aid, ['rev-parse', ':x/a.txt'])).out.trim();
        await gitIn(aid, ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',x/A.txt']);   // one tree spelling one file two ways, as an older capture could
        put(path.join(wt, 'app.js'), 'v1\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: x/a.txt and x/A.txt' });
        A.ok(!!t && (await tree(aid, t.id)).includes('x/a.txt') && (await tree(aid, t.id)).includes('x/A.txt'), 'fixture (tw2): T spells one file two ways');
        fs.rmSync(path.join(wt, 'x'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v2\n');
        await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no x' });
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"x\/[Aa]\.txt" and "x\/[Aa]\.txt" are one name to Git, spelled two ways in what rewinding would write/, 'tw2, a rewind to a tree that spells a file two ways');
      });
    }
    // the rows' Git reads no attributes file or global config of the person's, wherever this box keeps one
    process.env.XDG_CONFIG_HOME = path.join(BASE, 'no-config-home');
    process.env.GIT_CONFIG_GLOBAL = path.join(BASE, 'no-gitconfig');
    await runRows(rows, rowKit);
    {
      // this file runs past test/slow.list's 40 s rule, its rows eight at a time (slow.list says what it takes, under what load and
      // when); listed there, a gate gives it 600 s, not 120 s. Its rows were split from test/checkpoint-undo-case.test.js at undo review 12 so
      // that file keeps that much room too. A step of the fast gate, beside it
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-held.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-held.test.js'), steps('http.list').includes('test/checkpoint-undo-held.test.js')], [true, false], 'and a step of the fast gate alone');
    }
  } finally {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('checkpoint-undo-held.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-held.test threw — ' + (e && e.stack || e)); process.exit(1); });
