/* node test/checkpoint-undo-case.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where a folder's case was not what the checks
   read (lane checkpoint-links, undo reviews 9 and 10, 2026-11-02; sidecar/checkpoint-store.js, the header's THE PROMISE,
   restore's THE UNDO ROW RESTORES THROUGH THIS API and foldedTwoRefusal's CASE APART). Undo reviews 7 and 8's rows are
   test/checkpoint-undo-reads.test.js; these were split from it at undo review 11, so each step keeps its room under test/slow.list's 600 s (that file took 428 s and 446 s at
   87-88% CPU, as checkpoint-undo-gitlinks took 425.9 s and 461.7 s when undo review 9 split that file). Undo reviews 9 and 10's rows moved as
   they stood, but for csz and csx, whose refusals undo review 11's rules made them. Undo review 11's rows were here too until undo review 12
   measured this file at 396.7 s and 476.8 s at 84-88% CPU, past the lane's 300 s a step: they moved as they stood to
   test/checkpoint-undo-folders.test.js (an empty folder no capture records, a name the disk spells otherwise) and
   test/checkpoint-undo-held.test.js (what Git leaves, a reset that stops partway), which holds undo review 12's rows too.

   Undo review 9 found, at b5355821, each with both calls ok:true unless it says otherwise (the block below says more):
     cs5 csa csb cs2 csl  a folder that reads case apart (Windows' per-folder case sensitivity: every folder WSL makes, any fsutil marks), where Git's
           core.ignorecase reads two names in A-Z case apart as one and opens `.gitignore` by its exact name: the person's untracked file
           kept out of the rewind's capture by a `.GITIGNORE` Git never reads there, then taken and deleted by the undo (since c8e20497),
           a file beside its twin in no row, and a capture that stored the person's file at its twin's length. Refused now, and a capture
           is skipped while such twins stand; csw csl2 refusals the same rule makes; cs6 cse csm csn csr the controls, both calls;
     ghe   a hook named "" ([hook ""]) was never switched off: it ran on the shadow repo and the undo answered git_failed.
   Undo review 10 found, at 37ab3794 (the block below says more):
     csd5 csge csep  a folder no name could ask whether it reads case apart (one that holds nothing, or only names with no letter A-Z), whose entries
           the reset changed: a folder it made there took that case, and the undo, writing the person's FILE back, meeting a gitlink's empty folder or
           leaving the folder above holding only such names, was refused on every try (csep found in this repair). Refused now; csz the control, all
           three calls; csx a refusal the same rule makes, T spelling such an empty folder another way;
     cap8 capb  eight pairs in A-Z case apart at the top of a clone filled the walk's list of twins, so the person's pair below it went unseen: a
           rewind went ahead and its undo was refused, and a capture stored the person's file cut to its twin's length. Every folder keeps its pair now;
     nest1 ex1  a folder respelled in another case since the last capture: the reset deleted nothing there and the rewind answered ok. The case-apart
           exception asks every component as it stands now (ex1 pins the last);
     csgd  found in this repair, in a plain folder: a gitlink's empty folder that the reset removes, beside a name with no letter A-Z, left that
           folder holding only such names and the undo was refused on every try. Refused now; csdf csgc csre refusals the same rules make, each
           of which 37ab3794 round-trips (a FILE or a gitlink over a folder, a clone's gitlink dropped, a rewind to an empty tree); csgu
           the repair's own listing cut off by the capped runner, refused, never read as "none".
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The rows run eight at a time (runRows): each owns its agent id, work tree and its capped runner's list of
   cut-off listings, so none reads another's state or timing, and one that throws fails alone. csgu uses the
   real runner capped at 1500 bytes. Every row runs against a real temp work tree and real git (test/helpers/checkpoint-rows.js says how
   the rows run and how Git is started); the rows' Git reads no global config or attributes file of the person's.
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), all inside this test's own os.tmpdir() folder. A folder
   that reads case apart is made with `fsutil file setCaseSensitiveInfo <folder> enable` (no administrator rights needed), and fsutil itself
   is asked that it does; where it cannot, the row says so and is skipped. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-case-')));
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
      // ================= undo review 10: what the checks could not ask, a full list of twins, a folder respelled =================
      // A FOLDER NO NAME CAN ASK (security BLOCKER 1, a regression in 69668e6e). A folder that holds nothing, or only names with no letter A-Z, is never
      // asked whether it reads case apart, and a folder the reset makes takes the case of the folder it is made in. csd5: data reads case apart and
      // holds 1 and the person's FILE 2; T's data/2/x.txt made a folder of 2 that read case apart, so the undo, writing the FILE back, could not empty it
      // and was refused on every try. csge: an empty folder that reads case apart, which T's x.txt and a clone's gitlink were written into: the undo met
      // the gitlink's empty folder and could not count it as emptied. csep, found in this repair: T's cs/a.txt written into an empty data/cs that reads
      // case apart, data holding only 1 besides it: the undo, emptying cs, would leave data holding only 1, and refused on every try. Refused now: a
      // folder whose entries the reset changes that holds only such names, unless the reset empties it (csd5; csz, the control that empties one, goes
      // ahead, all three calls); and an empty one written into, unless its undo empties it as written and asks the folder above it on both sides (csge,
      // csep, and csx: T spells it CS, which the undo, deleting as the tree spells each component, could not reach there).
      // A FULL LIST OF TWINS (security BLOCKER 2, correctness BLOCKER 3). The walk kept eight pairs, and lists a clone's top before it knows the clone is
      // one: eight pairs there filled the list, so the person's pair below went unseen. cap8: csa's shape beside such a clone (the rewind went ahead and
      // its undo was refused); capb: csb's (the capture stored the person's file cut to its twin's length). Every folder keeps its first pair now.
      // A FOLDER RESPELLED (correctness BLOCKER 4). nest1: P reads case apart; S1 took P/Cs/a.txt; the person renamed Cs to cs, which the next capture
      // keeps under the index's spelling (core.ignorecase). The reset deleted P/Cs/a.txt, which is not there, and the rewind answered ok with P/cs/a.txt
      // standing; its undo was refused on every try. The case-apart exception asks each component spelled as it stands now. ex1 pins the last one: S1's
      // cs/a.txt renamed cs/A.txt. Both pause past Git's racy window, so the capture keeps the index's spelling and the refusal is the checks' own.
      const winOnly = (aid) => { if (isWin) return true; console.log('[skip] ' + aid + ': a folder that reads case apart is made here with Windows\' fsutil'); return false; };
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const unaskedRe = /^"data" holds only names with no letter A-Z, so the checks could not ask whether it reads names in another case apart/;
      const emptyRe = (dir, how) => new RegExp('^"' + dir + '" holds nothing, so the checks could not ask whether it reads names in another case apart \\(a case-sensitive folder, as WSL makes one and fsutil marks one\\), and rewinding would write into it ' + how);
      const eightPairs = () => { const f = {}; for (const c of 'abcdefgh') { f[c + '.txt'] = 'small ' + c + '\n'; f[c.toUpperCase() + '.txt'] = 'capital ' + c.toUpperCase() + ', beside it in the clone\n'; } return f; };
      row('csd5', async ({ refusedClean }) => {
        const aid = 'csd5', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        if (!caseApart(aid, path.join(wt, 'data'))) return;
        put(path.join(wt, 'data', '1'), 'one\n');
        put(path.join(wt, 'data', '2', 'x.txt'), 'T x\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/1 and data/2/x.txt' });
        fs.rmSync(path.join(wt, 'data', '2'), { recursive: true });
        put(path.join(wt, 'data', '2'), 'the person\'s FILE data/2\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/1 and the FILE data/2' });
        A.eq([!!(s1 && s1.created), s1 ? (await tree(aid, s1.id)).sort() : null], [true, ['app.js', 'data/1', 'data/2']], 'fixture (csd5): S1 holds the FILE data/2 beside data/1');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', unaskedRe, 'csd5, a rewind that makes a folder of the FILE data/2, in a folder that reads case apart and holds only names with no letter A-Z');
      });
      // csz went ahead, all three calls, until undo review 11: with data/1 held open by another program, Git left it, and the undo, writing data/2
      // back beside it in a folder no name asks, was refused on every try (hp1, the same in a folder that folds). Refused now (PARTIAL)
      row('csz', async ({ refusedClean }) => {
        const aid = 'csz', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no data' });
        if (!caseApart(aid, path.join(wt, 'data'))) return;
        put(path.join(wt, 'data', '1'), 'one\n');
        put(path.join(wt, 'data', '2'), 'two\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/1 and data/2' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"data\/[12]" has no letter A-Z in its name, and rewinding would empty "data", which holds it/, 'csz, a rewind that empties a folder that reads case apart and holds only names with no letter A-Z');
      });
      row('csge', async ({ refusedClean }) => {
        const aid = 'csge', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'data', 'x.txt'), 'T x\n');
        await clone(path.join(wt, 'data', 'sub'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/x.txt and a clone at data/sub' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tdata\/sub$/m.test(await treeRecs(aid, t.id)), 'fixture (csge): T records the clone data/sub as a gitlink');
        fs.rmSync(path.join(wt, 'data'), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no data' });
        if (!caseApart(aid, path.join(wt, 'data'))) return;
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', emptyRe('data', 'an embedded repository\'s empty folder'), 'csge, a rewind that writes T\'s x.txt and a gitlink into an empty folder that reads case apart');
      });
      row('csep', async ({ refusedClean }) => {
        const aid = 'csep', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'data', '1'), 'one\n');
        put(path.join(wt, 'data', 'cs', 'a.txt'), 'T a\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/1 and data/cs/a.txt' });
        fs.rmSync(path.join(wt, 'data', 'cs'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/1' });
        if (!caseApart(aid, path.join(wt, 'data', 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', emptyRe('data/cs', 'while the folder above it, "data", holds no other name with a letter A-Z'), 'csep, a rewind into an empty folder that reads case apart, the folder above it holding only 1 besides it');
      });
      row('csx', async ({ refusedClean }) => {
        const aid = 'csx', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'CS', 'a.txt'), 'T a\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: CS/a.txt' });
        fs.rmSync(path.join(wt, 'CS'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no CS' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"cs" is spelled "CS" in the restore point/, 'csx, a rewind of T\'s CS/a.txt into an empty folder cs that reads case apart');
      });
      row('cap8', async ({ refusedClean }) => {
        const aid = 'cap8', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'src', 'keep.txt'), 'keep\n');
        if (!caseApart(aid, path.join(wt, 'lib'))) return;
        await clone(path.join(wt, 'lib'), eightPairs());
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a clone lib, eight pairs in A-Z case apart at its top' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tlib$/m.test(await treeRecs(aid, t.id)), 'fixture (cap8): T is taken beside the clone\'s eight pairs, and records lib as a gitlink');
        if (!caseApart(aid, path.join(wt, 'src', 'cs'))) return;
        put(path.join(wt, 'src', 'cs', 'a.txt'), 'small a, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: src/cs/a.txt' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes('src/cs/a.txt'), 'fixture (cap8): S1 holds src/cs/a.txt');
        put(path.join(wt, 'src', 'cs', 'A.txt'), PERSON);
        put(path.join(wt, 'app.js'), 'v2\n');
        const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: the person wrote src/cs/A.txt' });
        A.eq(s2, null, 'cap8: a capture while src/cs/a.txt and src/cs/A.txt stand side by side, a clone with eight such pairs beside them, is skipped (' + JSON.stringify(s2) + ')');
        A.ok(twinsRe.test(healthOf(store, aid)), 'cap8: and health says why (' + JSON.stringify(healthOf(store, aid)) + ')');
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"src\/cs\/[Aa]\.txt" and "src\/cs\/[Aa]\.txt" stand side by side in a folder that reads case apart/, 'cap8, a rewind to a point before src/cs, two names Git reads as one standing in it');
      });
      row('capb', async ({ refusedClean }) => {
        const aid = 'capb', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        if (!caseApart(aid, path.join(wt, 'lib'))) return;
        await clone(path.join(wt, 'lib'), eightPairs());
        if (!caseApart(aid, path.join(wt, 'src', 'cs'))) return;
        put(path.join(wt, 'src', 'cs', 'A.txt'), 'T: capital A\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: src/cs/A.txt, beside a clone with eight pairs' });
        A.ok(!!t && (await tree(aid, t.id)).includes('src/cs/A.txt'), 'fixture (capb): T holds src/cs/A.txt');
        put(path.join(wt, 'src', 'cs', 'a.txt'), 'small a\n');
        put(path.join(wt, 'src', 'cs', 'A.txt'), PERSON);
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the person\'s src/cs/A.txt beside src/cs/a.txt' });
        A.eq(s1, null, 'capb: a capture of the person\'s src/cs/A.txt beside src/cs/a.txt, a clone with eight such pairs beside them, is skipped, not stored at the twin\'s length (' + JSON.stringify(s1) + ')');
        A.ok(twinsRe.test(healthOf(store, aid)), 'capb: and health says why (' + JSON.stringify(healthOf(store, aid)) + ')');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', twinsRe, 'capb, a rewind to T, the two standing side by side');
      });
      row('nest1', async ({ refusedClean }) => {
        const aid = 'nest1', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no P' });
        if (!caseApart(aid, path.join(wt, 'P'))) return;
        put(path.join(wt, 'P', 'Cs', 'a.txt'), 'a, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await pause(2100);
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: P/Cs/a.txt' });
        A.ok(!!s1 && (await tree(aid, s1.id)).includes('P/Cs/a.txt'), 'fixture (nest1): S1 holds P/Cs/a.txt');
        fs.renameSync(path.join(wt, 'P', 'Cs'), path.join(wt, 'P', 'cs'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await pause(2100);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"P" reads names in another case apart \("P\/cs" is there and "P\/Cs" is not: a case-sensitive folder/, 'nest1, a rewind to a point before P, its folder Cs renamed cs since S1');
      });
      row('ex1', async ({ refusedClean }) => {
        const aid = 'ex1', wt = path.join(ROOT, aid);
        if (!winOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: no cs' });
        if (!caseApart(aid, path.join(wt, 'cs'))) return;
        put(path.join(wt, 'cs', 'a.txt'), 'a, captured\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await pause(2100);
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs/a.txt' });
        fs.renameSync(path.join(wt, 'cs', 'a.txt'), path.join(wt, 'cs', 'A.txt'));
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await pause(2100);
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', apartRe, 'ex1, a rewind to a point before cs, its a.txt renamed A.txt since S1');
      });
      // A FOLDER'S ENTRIES CHANGE where a gitlink's empty folder comes or goes too, and where a FILE or a gitlink is written over a folder (found in this
      // repair, each with plain folders, wherever the store folds case). csgd: vendor holds 1 and a gitlink's empty folder sub (a rewind to the clone made it
      // there); T lacks the gitlink, Git removes that folder, and the undo, recording it again beside 1, was refused on every try (37ab3794 the same):
      // refused now, as a rewind that leaves vendor holding only 1. csdf, csgc: T's FILE data/2 over a folder, and a clone's gitlink dropped where Git leaves
      // the clone, each in a folder that holds only names with no letter A-Z, which its undo would change too: refused, though both round-trip on 37ab3794.
      // csre: a rewind to an empty tree that drops a gitlink's empty folder, which its undo would record in a folder that holds nothing: refused (37ab3794
      // round-trips it). On a file system that reads every name as spelled, each goes ahead, both calls.
      const unaskedEverywhere = /^"data" holds only names with no letter A-Z, so the checks could not ask whether it reads names in another case apart/;
      row('csgd', async ({ twoCalls, refusedClean }) => {
        const aid = 'csgd', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'vendor', '1'), 'one\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: vendor/1' });
        await clone(path.join(wt, 'vendor', 'sub'), { 'm.txt': 'module\n' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the clone vendor/sub' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tvendor\/sub$/m.test(await treeRecs(aid, s1.id)), 'fixture (csgd): S1 records the clone vendor/sub as a gitlink');
        fs.rmSync(path.join(wt, 'vendor', 'sub'), { recursive: true, force: true });
        fs.mkdirSync(path.join(wt, 'vendor', 'sub'));       // the clone gone, its empty folder left, as a rewind to it makes one
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (!foldsCase) { await twoCalls(store, aid, wt, t.id, 'csgd, where the file system reads every name as spelled'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"vendor" holds names with no letter A-Z on one side of this rewind/, 'csgd, a rewind that drops the gitlink of an empty folder vendor/sub beside vendor/1');
      });
      row('csdf', async ({ twoCalls, refusedClean }) => {
        const aid = 'csdf', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'data', '2'), 'T: the FILE data/2\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the FILE data/2' });
        fs.unlinkSync(path.join(wt, 'data', '2'));
        put(path.join(wt, 'data', '2', 'x.txt'), 'the person\'s data/2/x.txt\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/2/x.txt' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (!foldsCase) { await twoCalls(store, aid, wt, t.id, 'csdf, where the file system reads every name as spelled'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', unaskedEverywhere, 'csdf, a rewind that writes T\'s FILE data/2 over a folder, in a folder that holds only names with no letter A-Z');
      });
      row('csgc', async ({ twoCalls, refusedClean }) => {
        const aid = 'csgc', wt = path.join(ROOT, aid);
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'data', '1'), 'one\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/1' });
        await clone(path.join(wt, 'data', '7'), { 'm.txt': 'module\n' });
        put(path.join(wt, 'app.js'), 'v1\n');
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the clone data/7' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tdata\/7$/m.test(await treeRecs(aid, s1.id)), 'fixture (csgc): S1 records the clone data/7 as a gitlink');
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        if (!foldsCase) { await twoCalls(store, aid, wt, t.id, 'csgc, where the file system reads every name as spelled'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', unaskedEverywhere, 'csgc, a rewind that drops the gitlink of the clone data/7, in a folder that holds only names with no letter A-Z');
      });
      row('csre', async ({ twoCalls, refusedClean }) => {
        const aid = 'csre', wt = path.join(ROOT, aid);
        fs.mkdirSync(wt, { recursive: true });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: nothing' });
        A.eq([!!(t && t.created), t ? await tree(aid, t.id) : null], [true, []], 'fixture (csre): T is taken of a folder that holds nothing, an empty tree');
        await clone(path.join(wt, 'sub'), { 'm.txt': 'module\n' });
        const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: the clone sub' });
        A.ok(!!s1 && /^160000 commit [0-9a-f]+\tsub$/m.test(await treeRecs(aid, s1.id)), 'fixture (csre): S1 records the clone sub as a gitlink');
        fs.rmSync(path.join(wt, 'sub'), { recursive: true, force: true });
        fs.mkdirSync(path.join(wt, 'sub'));                 // the clone gone, its empty folder left
        if (!foldsCase) { await twoCalls(store, aid, wt, t.id, 'csre, where the file system reads every name as spelled'); return; }
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^rewinding would leave the folder holding nothing and drop the embedded repository "sub"/, 'csre, a rewind to an empty tree that drops a gitlink\'s empty folder');
      });
      // A LISTING CUT OFF IS NO ANSWER, through the real runner capped at 1500 bytes: csgu, T's 240 files in 24 folders below an empty folder cs,
      // whose modes alone (the listing that says whether T records a gitlink there) pass the limit: refused, untouched, never read as "none"
      row('csgu', async ({ cut, refusedClean }) => {
        const aid = 'csgu', wt = path.join(ROOT, aid);
        if (!foldsCase) { console.log('[skip] csgu: the store asks what a folder reads only where the file system folds case'); return; }
        const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let d = 0; d < 24; d++) for (let f = 0; f < 10; f++) put(path.join(wt, 'cs', 'd' + d, 'f' + f + '.txt'), 'T ' + d + ' ' + f + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 240 files below cs' });
        fs.rmSync(path.join(wt, 'cs'), { recursive: true });
        fs.mkdirSync(path.join(wt, 'cs'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: cs holds nothing' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        cut.length = 0;
        await refusedClean(st, aid, wt, t.id, 'uncaptured_check_failed', /^Git could not list what the restore point holds in "cs", a folder that holds nothing/, 'csgu, a rewind into an empty folder whose listing of the restore point there passes the capped runner\'s limit');
        A.ok(cut.includes('ls-tree'), 'csgu: that listing passed the limit (' + JSON.stringify(cut) + ')');
      });
    }
    // the rows' Git reads no attributes file or global config of the person's, wherever this box keeps one
    process.env.XDG_CONFIG_HOME = path.join(BASE, 'no-config-home');
    process.env.GIT_CONFIG_GLOBAL = path.join(BASE, 'no-gitconfig');
    await runRows(rows, rowKit);
    {
      // this file runs past test/slow.list's 40 s rule, its rows eight at a time (slow.list says what it takes, under what load and
      // when); listed there, a gate gives it 600 s, not 120 s. Its rows were split from test/checkpoint-undo-reads.test.js so
      // that file keeps that much room too. A step of the fast gate, beside it
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-case.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-case.test.js'), steps('http.list').includes('test/checkpoint-undo-case.test.js')], [true, false], 'and a step of the fast gate alone');
    }
  } finally {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('checkpoint-undo-case.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-case.test threw — ' + (e && e.stack || e)); process.exit(1); });
