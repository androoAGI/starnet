/* node test/checkpoint-undo-folders.test.js — a completed rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row, where a folder no capture records (one that
   holds nothing, or only folders that do) meets a FILE, a gitlink or a write, where a FILE replaces a folder, or where a
   tree spells a name otherwise than the disk (lane checkpoint-links, undo review 11, 2026-11-02; sidecar/checkpoint-store.js,
   the header's THE PROMISE, restore's THE UNDO ROW RESTORES THROUGH THIS API and foldedTwoRefusal's WHAT GIT LEAVES). These rows
   were test/checkpoint-undo-case.test.js's until undo review 12 measured that file at 396.7 s and 476.8 s at 84-88% CPU, past the
   lane's 300 s a step: they moved here as they stood, and undo review 11's rows of what Git leaves and of a reset that stops
   partway to test/checkpoint-undo-held.test.js.

   Undo review 11 found, at d7247072 (the block below says more):
     eg1 egr eg2 ef1  a gitlink or a FILE written where an empty folder stands: its undo removed that folder and nothing made it again, so the folder above lost a name
           (eg1, egr, eg2 regressions of d80dabc5, ef1 open since 69668e6e); efn the same where it holds only an empty folder, found by a model check of that repair; eg0 ef0 the controls;
     ie2   two empty folders written into, each the other's name with a letter A-Z, beside a name with none (open since 69668e6e); ie2c the control;
     c1 k1  what no row pinned: the climb past a folder that holds nothing else, and the whole target counted where that climb reaches the root.
   And found in that repair, each stranding an undo or, in fn1 fn2, bringing a file back under another name (at d7247072 unless it says otherwise):
     mp mg ms  the repair's own rules, asked of the undo: a rewind that makes a folder they would refuse its undo to remove (d7247072 round-trips them);
     rp1 rp2  a FILE written where a folder of names with no letter stands, the same rules on a folder the reset replaces; rp3 rp4 the controls;
     fn1 fn2 fn3 fn4  a name the disk spells otherwise than a tree: Readme.md came back where README.md stood. Any such path refuses a rewind now, checkpoint-undo Ks and
           test/checkpoint-undo-closure.test.js fr6 among them (fn3 fn4 Ks fr6 round-trip at d7247072); csr (test/checkpoint-undo-case.test.js) and h4acs the controls, a file deleted first and a folder a FILE replaces;
     tw1   two spellings of one folder in one tree, which no row pinned (d7247072's noTwinsEmpty mutant lived);
     csgb csgs csgr csgv csgm  that repair's listings cut off by the capped runner, refused, never read as "none"; mp2 ie3 eg3 the rows that pin those rules' other arms.
   Each row runs the two calls (twoCalls: the rewind, then restoreDetailed(preRestoreId), every path and byte of the work
   tree compared with before the rewind) or pins the refusal (refusedClean: refused, no undo row, every path and byte as
   it was). The rows run eight at a time (runRows): each owns its agent id, work tree and its capped runner's list of
   cut-off listings, so none reads another's state or timing, and one that throws fails alone. csgb, csgs, csgr, csgv and csgm use the
   real runner capped at 1500 bytes. Every row runs against a real temp work tree and real git (test/helpers/checkpoint-rows.js says how
   the rows run and how Git is started); the rows' Git reads no global config or attributes file of the person's.
   Fixtures: clones (their own .git, made by this file's git, never the shadow repo), all inside this test's own os.tmpdir() folder. None of
   these rows runs where the file system does not fold case: each says so and is skipped there. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');

const isWin = process.platform === 'win32';
const foldsCase = isWin || process.platform === 'darwin';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-folders-')));
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
    {
      // ================= undo review 11: a FILE or a gitlink where an empty folder stands, two empty folders, a name the disk spells otherwise (moved from test/checkpoint-undo-case.test.js at undo review 12) =================
      // A FILE OR A GITLINK WHERE AN EMPTY FOLDER STANDS (correctness BLOCKER 3): its undo deletes the FILE or drops the gitlink, Git removes that
      // folder, and no capture makes it again, so the folder above lost a name: eg1 (a gitlink beside data/1), egr (beside the root's 1), eg2 (the
      // root holding only that folder), ef1 (a FILE beside data/1), efn (that folder holding only an empty folder), each stranding the undo, refused now (AT); eg0 and ef0, with data/readme.md
      // beside, the controls. TWO EMPTY FOLDERS (correctness BLOCKER 4): ie2, data/cs and data/ds beside data/1, each the other's lettered name
      // for EMPTY, its undo leaving data holding only 1: refused (U); ie2c the control. THE CLIMB AND THE ROOT (correctness MAJOR 5): c1, a holding
      // only an empty cs beside the root's 1, and k1, the root holding only an empty e with T's clone g, which no row pinned.
      // FOUND IN THAT REPAIR. Each rule that refuses a rewind refuses an undo too, so a rewind that would make its undo meet one is refused first (ITS UNDO'S
      // OWN): mp, a folder the rewind makes holding 1 and 2; mp2, an empty one it fills so; ie3, two empty ones it fills, all data holds; mg, a folder it makes
      // holding a clone's gitlink; eg3, that gitlink at the foot of folders that hold only the next. A FOLDER A FILE REPLACES must go as one the reset empties
      // does: rp1, rp2, its undo making that folder again, and rp1 with data/1 held stranded the undo at d7247072; rp3, rp4 the controls. A NAME
      // THE DISK SPELLS OTHERWISE (SPELLED): fn1 and fn2, Readme.md renamed README.md since S1, deleted or written over, came back as Readme.md, ok:true; fn3, a
      // file in a folder renamed so, which round-tripped; fn4, T's Src/a.js against S2's src/a.js, which round-tripped; ms, a folder made below one so, each refused
      // as the steering of undo review 10 asks, so its undo meets each name in one spelling. tw1: two spellings of one name in one tree, which that undo would meet so.
      // csgb, csgs, csgr, csgv, csgm: the listings of these rules past the capped runner's limit, no answer. (The rows of what Git leaves, and of a reset that
      // stops partway, are test/checkpoint-undo-held.test.js's.)
      const emptyRe = (dir, how) => new RegExp('^"' + dir + '" holds nothing, so the checks could not ask whether it reads names in another case apart \\(a case-sensitive folder, as WSL makes one and fsutil marks one\\), and rewinding would write into it ' + how);
      const partialRe = (name, dir) => new RegExp('^"' + name + '" has no letter A-Z in its name, and rewinding would empty "' + dir + '", which holds it: were Git to leave something in that folder');
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
      const atRe = (dir, above) => new RegExp('^"' + dir + '" holds no file, so the checks could not ask whether it reads names in another case apart \\(a case-sensitive folder, as WSL makes one and fsutil marks one\\), and rewinding would write a file or an embedded repository where it stands while the folder above it, "' + above.replace('.', '\\.') + '", holds no other name with a letter A-Z');
      for (const [aid, sib, at, refused, deep] of [['eg1', ['1'], 'gitlink', true], ['eg0', ['1', 'readme.md'], 'gitlink', false], ['ef1', ['1'], 'file', true], ['efn', ['1'], 'file', true, true], ['ef0', ['1', 'readme.md'], 'file', false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid), f = at === 'gitlink' ? 'sub' : 'f';
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        for (const s of sib) put(path.join(wt, 'data', s), 'T ' + s + '\n');
        if (at === 'gitlink') await clone(path.join(wt, 'data', f), { 'm.txt': 'module\n' }); else put(path.join(wt, 'data', f), 'T: the FILE data/f\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/' + f + (at === 'gitlink' ? ', a clone' : ', a FILE') });
        if (at === 'gitlink') A.ok(!!t && /^160000 commit [0-9a-f]+\tdata\/sub$/m.test(await treeRecs(aid, t.id)), 'fixture (' + aid + '): T records the clone data/sub as a gitlink');
        fs.rmSync(path.join(wt, 'data', f), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no data/' + f });
        fs.mkdirSync(path.join(wt, 'data', f));             // an empty folder of the person's where T's clone or FILE was
        if (deep) fs.mkdirSync(path.join(wt, 'data', f, 'e'));   // one that holds only an empty folder, which no capture records either
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind that writes T\'s ' + (at === 'gitlink' ? 'gitlink' : 'FILE') + ' data/' + f + ' where an empty folder stands, beside ' + sib.join(' and ');
        if (refused) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', atRe('data/' + f, 'data'), label);
        else await twoCalls(store, aid, wt, t.id, label);
      });
      for (const [aid, beside] of [['egr', true], ['eg2', false]]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        if (beside) put(path.join(wt, '1'), 'one\n');
        await clone(path.join(wt, 'sub'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the clone sub' + (beside ? ' beside 1' : ' alone') });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tsub$/m.test(await treeRecs(aid, t.id)), 'fixture (' + aid + '): T records the clone sub as a gitlink');
        fs.rmSync(path.join(wt, 'sub'), { recursive: true, force: true });
        if (beside) put(path.join(wt, '1'), 'one, v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no sub' });
        fs.mkdirSync(path.join(wt, 'sub'));
        if (beside) put(path.join(wt, '1'), 'one, v2: no snapshot took this\n');
        const label = aid + ', a rewind that records the gitlink sub where an empty folder stands, ' + (beside ? 'beside the root\'s 1' : 'the root holding nothing else');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', beside ? atRe('sub', '.') : /^"sub" holds no file, .* where it stands while every folder above it holds nothing else, and the restore point records an embedded repository \(a gitlink\)/, label);
      });
      for (const [aid, extra, refused] of [['ie2', {}, true], ['ie2c', { 'data/readme.md': 'T readme\n' }, false]]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        for (const [rel, body] of Object.entries(Object.assign({ 'app.js': 'v0\n', 'data/1': 'one\n', 'data/cs/a.txt': 'T a\n', 'data/ds/b.txt': 'T b\n' }, extra))) put(path.join(wt, rel), body);
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/cs/a.txt and data/ds/b.txt beside data/1' });
        fs.unlinkSync(path.join(wt, 'data', 'cs', 'a.txt'));
        fs.unlinkSync(path.join(wt, 'data', 'ds', 'b.txt'));   // both folders kept, holding nothing
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: data/1' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        const label = aid + ', a rewind into the empty folders data/cs and data/ds beside data/1' + (refused ? '' : ' and data/readme.md');
        if (refused) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', emptyRe('data/cs', 'while the folder above it, "data", holds no other name with a letter A-Z'), label);
        else await twoCalls(store, aid, wt, t.id, label);
      });
      row('c1', async ({ refusedClean }) => {
        const aid = 'c1', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, '1'), 'one\n');
        put(path.join(wt, 'a', 'cs', 'f.txt'), 'T f\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: 1 and a/cs/f.txt' });
        fs.unlinkSync(path.join(wt, 'a', 'cs', 'f.txt'));
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: 1, a/cs holding nothing' });
        put(path.join(wt, '1'), 'one, v2: no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', emptyRe('a/cs', 'while the folder above it, "\\.", holds no other name with a letter A-Z'), 'c1, a rewind into the empty a/cs, a holding nothing else, beside the root\'s 1');
      });
      row('k1', async ({ refusedClean }) => {
        const aid = 'k1', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'e', 'a.txt'), 'T a\n');
        await clone(path.join(wt, 'g'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: e/a.txt and the clone g' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tg$/m.test(await treeRecs(aid, t.id)), 'fixture (k1): T records the clone g as a gitlink');
        fs.unlinkSync(path.join(wt, 'e', 'a.txt'));
        fs.rmSync(path.join(wt, 'g'), { recursive: true, force: true });
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: e holding nothing, no g' });
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', emptyRe('e', 'while every folder above it holds nothing else, and the restore point records an embedded repository \\(a gitlink\\)'), 'k1, a rewind into the empty e, the root holding nothing else, T recording the clone g');
      });
      row('mp', async ({ refusedClean }) => {
        const aid = 'mp', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'data', '1'), 'T one\n');
        put(path.join(wt, 'data', '2'), 'T two\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: data/1 and data/2' });
        fs.rmSync(path.join(wt, 'data'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no data' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"data\/[12]" has no letter A-Z in its name, and rewinding would leave it beside another name in "data", a folder it makes or fills where it holds nothing, which its undo would empty/, 'mp, a rewind that makes data holding 1 and 2');
      });
      // mp2: the same in an empty folder the rewind fills. ie3: two empty folders it fills that hold, between them, all of data, whose names hold no letter.
      // eg3: a gitlink written at data/x/sub, where each folder above holds only the next, down to that empty folder
      row('mp2', async ({ refusedClean }) => {
        const aid = 'mp2', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        const t = await twoTrees(aid, wt, { 'app.js': 'v0\n', 'data/1': 'T one\n', 'data/2': 'T two\n' }, { 'app.js': 'v1\n' });
        fs.mkdirSync(path.join(wt, 'data'));
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"data\/[12]" has no letter A-Z in its name, and rewinding would leave it beside another name in "data"/, 'mp2, a rewind that fills the empty folder data with 1 and 2');
      });
      row('ie3', async ({ refusedClean }) => {
        const aid = 'ie3', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        const t = await twoTrees(aid, wt, { 'app.js': 'v0\n', 'data/1/a.txt': 'T a\n', 'data/2/b.txt': 'T b\n' }, { 'app.js': 'v1\n' });
        fs.mkdirSync(path.join(wt, 'data', '1'), { recursive: true });
        fs.mkdirSync(path.join(wt, 'data', '2'));
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"data\/1" has no letter A-Z in its name, and rewinding would leave it beside another name in "data"/, 'ie3, a rewind into the empty folders 1 and 2, all data holds');
      });
      row('eg3', async ({ refusedClean }) => {
        const aid = 'eg3', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        await clone(path.join(wt, 'data', 'x', 'sub'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: the clone data/x/sub' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tdata\/x\/sub$/m.test(await treeRecs(aid, t.id)), 'fixture (eg3): T records the clone data/x/sub as a gitlink');
        fs.rmSync(path.join(wt, 'data'), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no data' });
        fs.mkdirSync(path.join(wt, 'data', 'x', 'sub'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"data", a folder rewinding would make or fill where it holds nothing, would hold an embedded repository's empty folder/, 'eg3, a rewind that records data/x/sub where each folder above holds only the next');
      });
      row('mg', async ({ refusedClean }) => {
        const aid = 'mg', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'vendor', 'readme.md'), 'T readme\n');
        await clone(path.join(wt, 'vendor', 'lib'), { 'm.txt': 'module\n' });
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: vendor/readme.md and the clone vendor/lib' });
        A.ok(!!t && /^160000 commit [0-9a-f]+\tvendor\/lib$/m.test(await treeRecs(aid, t.id)), 'fixture (mg): T records the clone vendor/lib as a gitlink');
        fs.rmSync(path.join(wt, 'vendor'), { recursive: true, force: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: no vendor' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"vendor", a folder rewinding would make or fill where it holds nothing, would hold an embedded repository's empty folder \(a gitlink in the restore point\)/, 'mg, a rewind that makes vendor holding the gitlink vendor/lib');
      });
      row('ms', async ({ refusedClean }) => {
        const aid = 'ms', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'Src', 'keep.js'), 'keep\n');
        settle(path.join(wt, 'Src', 'keep.js'));
        put(path.join(wt, 'Src', 'New', 'a.js'), 'T a\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: Src/keep.js and Src/New/a.js' });
        fs.rmSync(path.join(wt, 'Src', 'New'), { recursive: true });
        fs.renameSync(path.join(wt, 'Src'), path.join(wt, 'src'));
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: src/keep.js, renamed from Src' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"src" is spelled "Src" in the restore point/, 'ms, a rewind that makes New below src, which T spells Src');
      });
      for (const [aid, files, refused, emptyIn] of [
        ['rp1', { 'data/1': 'one\n', 'data/2': 'two\n' }, true],
        ['rp2', { 'data/1/x.txt': 'x\n', 'data/b.txt': 'b\n' }, true],
        ['rp3', { 'data/1/x.txt': 'x\n' }, false, 'data/1/e'],   // an empty folder beside x.txt: Git deletes it with the rest, so 1 goes though the reset does not empty it
        ['rp4', { 'data/a.txt': 'a\n', 'data/b.txt': 'b\n' }, false]
      ]) row(aid, async ({ twoCalls, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        const t = await twoTrees(aid, wt, { 'app.js': 'v0\n', data: 'T: the FILE data\n' }, Object.assign({ 'app.js': 'v1\n' }, files));
        if (emptyIn) fs.mkdirSync(path.join(wt, emptyIn));
        const label = aid + ', a rewind that writes T\'s FILE data where a folder holding ' + Object.keys(files).join(' and ') + ' stands';
        if (refused) await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', partialRe('data/1', 'data'), label);
        else await twoCalls(store, aid, wt, t.id, label);
      });
      for (const [aid, tFiles, sFiles, rename, re] of [
        ['fn1', { 'app.js': 'v0\n' }, { 'app.js': 'v1\n', 'Readme.md': 'S1 readme\n' }, ['Readme.md', 'README.md'], /^"README\.md" is spelled "Readme\.md" in what rewinding would save as its undo/],
        ['fn2', { 'app.js': 'v0\n', 'Readme.md': 'T readme\n' }, { 'app.js': 'v1\n', 'Readme.md': 'S1 readme\n' }, ['Readme.md', 'README.md'], /^"README\.md" is spelled "Readme\.md" in the restore point/],
        ['fn3', { 'app.js': 'v0\n', 'Src/keep.js': 'keep\n' }, { 'app.js': 'v1\n', 'Src/keep.js': 'keep\n', 'Src/x.txt': 'S1 x\n' }, ['Src', 'src'], /^"src\/x\.txt" is spelled "Src\/x\.txt" in what rewinding would save as its undo/],
        ['fn4', { 'app.js': 'v0\n', 'Src/a.js': 'T a\n' }, { 'app.js': 'v1\n' }, null, /^"src" is spelled "Src" in the restore point/]
      ]) row(aid, async ({ refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        const t = await twoTrees(aid, wt, tFiles, sFiles, true);
        if (rename) fs.renameSync(path.join(wt, rename[0]), path.join(wt, rename[1]));
        else {                                                // no folder in S1, so the capture of src/a.js spells it as the disk does: a spelling of a tree's own
          put(path.join(wt, 'src', 'a.js'), 'S2 a\n');
          const s2 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S2: src/a.js' });
          A.ok(!!s2 && (await tree(aid, s2.id)).includes('src/a.js'), 'fixture (fn4): S2 spells src/a.js');
          put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        }
        const label = aid + ', a rewind where the disk spells a name otherwise than ' + (rename ? 'every capture' : 'the restore point');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', re, label);
      });
      row('tw1', async ({ refusedClean }) => {
        const aid = 'tw1', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(wt, 'New', 'a.txt'), 'T a\n');
        put(path.join(wt, 'New', 'b.txt'), 'T b\n');
        await store.snapshot(aid, { runId: 'r', turn: 0, label: 'New/a.txt and New/b.txt' });
        const blob = (await gitIn(aid, ['rev-parse', ':New/b.txt'])).out.trim();
        await gitIn(aid, ['rm', '--cached', '-q', 'New/b.txt']);
        await gitIn(aid, ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',NEW/b.txt']);   // one tree spelling one folder two ways, as an older capture could
        put(path.join(wt, 'app.js'), 'v1\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'T: New/a.txt and NEW/b.txt' });
        A.ok(!!t && (await tree(aid, t.id)).includes('NEW/b.txt') && (await tree(aid, t.id)).includes('New/a.txt'), 'fixture (tw1): T spells one folder two ways');
        fs.rmSync(path.join(wt, 'New'), { recursive: true });
        put(path.join(wt, 'app.js'), 'v2\n');
        await store.snapshot(aid, { runId: 'r', turn: 2, label: 'S1: no New' });
        put(path.join(wt, 'app.js'), 'v3, no snapshot took this\n');
        await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"(New|NEW)" and "(New|NEW)" are one name to Git, spelled two ways in what rewinding would write/, 'tw1, a rewind to a tree that spells a folder two ways');
      });
      // the listings these rules take, each past the capped runner's limit: no answer, never "none"
      const cappedStore = (cut) => makeCheckpointStore({ fs, pathMod: path, root: ROOT, clock, keep: 50, runGit: async (args, opts) => { const r = await cappedRunner(args, opts); if (r.truncated) cut.push(verbOf(args)); return r; } });
      const manyFiles = (dir, stamp) => { for (let d = 0; d < 24; d++) for (let f = 0; f < 10; f++) put(path.join(dir, 'd' + d, 'f' + f + '.txt'), stamp + ' ' + d + ' ' + f + '\n'); };
      for (const [aid, inT, re, what, keeps, fileT] of [
        ['csgb', false, /^Git could not list what the files rewinding would remove from "data" hold/, 'empties', true],
        ['csgs', false, /^Git could not list what the files rewinding would remove from "data" hold/, 'writes T\'s FILE at', true, true],
        ['csgr', false, /^Git could not list what the files rewinding would remove hold/, 'empties, leaving the root holding nothing,', false],
        ['csgv', true, /^Git could not list what the restore point holds in "data", a folder rewinding would make or fill/, 'makes', true]
      ]) row(aid, async ({ cut, refusedClean }) => {
        const wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        fs.mkdirSync(wt, { recursive: true });
        if (keeps) put(path.join(wt, 'app.js'), 'v0\n');
        if (inT) manyFiles(path.join(wt, 'data'), 'T');
        if (fileT) put(path.join(wt, 'data'), 'T: the FILE data\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T' });
        if (fileT) fs.unlinkSync(path.join(wt, 'data'));
        if (inT) fs.rmSync(path.join(wt, 'data'), { recursive: true }); else manyFiles(path.join(wt, 'data'), 'S1');
        if (keeps) put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1' });
        if (keeps) put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        cut.length = 0;
        await refusedClean(cappedStore(cut), aid, wt, t.id, 'uncaptured_check_failed', re, aid + ', a rewind that ' + what + ' a folder of 240 files, whose listing there passes the capped runner\'s limit');
        A.ok(cut.includes('ls-tree'), aid + ': that listing passed the limit (' + JSON.stringify(cut) + ')');
      });
      row('csgm', async ({ cut, refusedClean }) => {
        const aid = 'csgm', wt = path.join(ROOT, aid);
        if (!foldOnly(aid)) return;
        put(path.join(wt, 'app.js'), 'v0\n');
        for (let i = 0; i < 60; i++) put(path.join(wt, 'flat', flatName(i)), 'T ' + i + '\n');
        const t = await store.snapshot(aid, { runId: 'r', turn: 0, label: 'T: a flat folder of 60 long names' });
        for (let i = 0; i < 60; i++) put(path.join(wt, 'flat', flatName(i)), 'S1 ' + i + '\n');
        put(path.join(wt, 'app.js'), 'v1\n');
        await store.snapshot(aid, { runId: 'r', turn: 1, label: 'S1: each of them changed' });
        put(path.join(wt, 'app.js'), 'v2, no snapshot took this\n');
        cut.length = 0;
        await refusedClean(cappedStore(cut), aid, wt, t.id, 'uncaptured_check_failed', /^Git could not list what rewinding would write over/, 'csgm, a rewind that writes over a flat folder whose own entry list passes the capped runner\'s limit');
        A.ok(cut.includes('diff-tree') && cut.includes('ls-tree'), 'csgm: the listing and that folder\'s own entries passed the limit (' + JSON.stringify(cut) + ')');
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
      A.ok(steps('slow.list').includes('test/checkpoint-undo-folders.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-folders.test.js'), steps('http.list').includes('test/checkpoint-undo-folders.test.js')], [true, false], 'and a step of the fast gate alone');
    }
  } finally {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('checkpoint-undo-folders.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-folders.test threw — ' + (e && e.stack || e)); process.exit(1); });
