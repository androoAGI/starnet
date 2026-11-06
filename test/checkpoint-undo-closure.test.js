/* node test/checkpoint-undo-closure.test.js — a COMPLETED rewind's undo row restores through restoreDetailed, every path
   and byte, or the rewind is refused with no file touched and no undo row (lane checkpoint-links: final review 2 and the
   undo closure, the r3 review and Codex A4-2D1-01/02; sidecar/checkpoint-store.js, restore's THE UNDO ROW RESTORES THROUGH
   THIS API). These rows were test/checkpoint-links.test.js's row 20 (fr1-fr6: that file's header says what each found) until
   undo review 12's fix, when the gate's runner cut that file off at its 600 s on a box where one Git launch took 0.3-0.5 s at
   the median: they moved here as they stood, the split test/slow.list had named as the follow-up since undo review 1. fr3,
   fr3b and fr3c use the real runner capped at 1500 bytes, fr1 and fr5 a walk budget of 60 and 120 entries; every row runs against a
   real temp work tree and real git, the longest started first (test/helpers/checkpoint-rows.js says how the rows run and how
   Git is started). */
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
const { sidecarSourceFiles, locateSidecarFunction, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

const isWin = process.platform === 'win32';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-closure-')));
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
// an embedded repository with one commit: its own .git in the fixture, never the shadow repo; its commit starts no
// background `git maintenance run --auto`, as none of the store's own commits does
async function gitInit(dir) {
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  await gitRun(['init', '-q'], { cwd: dir });
  await gitRun(id.concat(['add', '-A']), { cwd: dir });
  await gitRun(id.concat(['commit', '-q', '-m', 'c']), { cwd: dir });
}
function fsWith(over) {   // the real fs with some fs.promises calls replaced
  const promises = Object.assign(Object.create(fs.promises), over);
  const out = Object.create(fs);
  Object.defineProperty(out, 'promises', { value: promises });
  return out;
}
function put(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
// the same without holding up the other rows (the fixtures of a thousand folders and more)
async function putAsync(file, body) { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, body); }
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
async function tree(aid, sha) {
  return (await gitRun(['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', sha])).split('\0').filter(Boolean);
}
const rowOf = (store, aid, id) => store.list(aid).snapshots.find((s) => s.id === id) || null;
const linkPaths = (x) => ((x && x.links) || []).map((l) => l.path).sort();

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  // each row owns its agent id, work tree and outside folders; the longest start first (row 20's, three snapshots or more each, with a
  // capped runner, a budget or two rewinds: test/checkpoint-links.test.js's own order, as they stood there), so no long row is left to run
  // alone at the end
  const rows = [], first = [];
  const row = (name, fn, early) => { (early ? first : rows).push({ name: name, fn: fn }); };
  try {
    // ================= 20. final review 2: a completed rewind's undo row restores through restoreDetailed =================
    row('fr1', async () => {
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
      A.eq(t0 && s1 && s1.created ? (await tree(aid, s1.id)) : [], ['.gitignore', 'app.js', 'package.json'], 'fixture: the walk prunes node_modules (budget 60), and no capture took it');
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
      A.ok(!!(u && u.preRestoreId) && !(await tree(aid, u.preRestoreId)).some((p) => /^node_modules\//.test(p)), 'the undo\'s own capture left node_modules out (the undo row ignores it), so its reset never deleted it');
      const again = await budget.restoreDetailed(aid, s1.id);
      A.eq([again && again.ok, bodyOf(path.join(wt, 'app.js')), fs.existsSync(path.join(nm, 'pkg7', 'lib', 'file_119.js'))], [true, 'v1\n', true],
        'and the row it was rewound from restores too, node_modules where it was');
    }, true);
    row('fr2', async () => {
      // fr2, the control: a folder only the target's .gitignore lists, which the target still tracks a file in (captured
      // before its rule). Now no rule lists dist, and dist holds a new keep.txt where the target holds one and a new
      // out.js, neither captured yet. dist is kept out of the capture like any folder only the target's rules prune (undo
      // closure: walked and captured whole, as before, its undo took what a rule had kept out of the rewind and deleted
      // it, fr4), but the capture takes the new keep.txt BY NAME, as the target writes over it (kept out with no more,
      // the new keep.txt was in no restore point, and the rewind refused), and leaves out.js where it is, as the rewound
      // .gitignore ignores it; reset writes the target's keep.txt, and the undo brings the new one back. The work tree's
      // rule is the plain name `logs` (it was `*.log`: since undo review 2 a rewind that changes a glob rule is refused, as
      // the store's THE RULES A REWIND CHANGES says; checkpoint-undo P3 pins that refusal on this very shape)
      const aid = 'fr2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'the target\'s keep.txt\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'dist/keep.txt captured' });
      put(path.join(wt, '.gitignore'), 'dist\n');
      const t0 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'dist ignored, keep.txt still tracked' });
      A.ok(t0 && t0.created && (await tree(aid, t0.id)).includes('dist/keep.txt'), 'fixture: the target ignores dist and tracks dist/keep.txt');
      fs.unlinkSync(path.join(wt, 'dist', 'keep.txt'));
      put(path.join(wt, '.gitignore'), 'logs\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'no dist rule, no keep.txt' });
      A.ok(s1 && s1.created && !(await tree(aid, s1.id)).includes('dist/keep.txt'), 'fixture: keep.txt is gone from the index');
      put(path.join(wt, 'dist', 'keep.txt'), 'NEWER keep.txt, no capture yet\n');
      put(path.join(wt, 'dist', 'out.js'), 'built, no capture yet\n');
      const before = listing(wt);
      const r = await store.restoreDetailed(aid, t0.id);
      A.eq(r && r.ok, true, 'the rewind goes ahead (' + JSON.stringify(r) + ')');
      A.eq([bodyOf(path.join(wt, 'dist', 'keep.txt')), bodyOf(path.join(wt, 'dist', 'out.js'))], ['the target\'s keep.txt\n', 'built, no capture yet\n'], 'writing the target\'s keep.txt and keeping out.js where it is');
      const held = r && r.preRestoreId ? (await tree(aid, r.preRestoreId)) : [];
      A.ok(held.includes('dist/keep.txt') && !held.includes('dist/out.js'), 'the new keep.txt in the undo row, taken by name; out.js left out, as a capture of the rewound tree leaves it out too');
      const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(u) + ')');
      A.eq(listing(wt), before, 'and every path and byte is back: the newer keep.txt and out.js');
    }, true);
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
      runGit: makeCheckpointGitRunner({ spawn: launchSpawn, maxBytes: 1500, clock: { now: () => Date.now() } }) });
    row('fr3', async () => {
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
    }, true);
    row('fr3b', async () => {
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
    }, true);
    row('fr3c', async () => {
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
    }, true);
    {
      // fr4 (r3 MAJOR): S1 tracks 16 node_modules files and no rule lists the folder; S2's .gitignore lists it, 40 extras
      // went in since, no capture takes them; app.js v2 since. The rewind to S1 prunes node_modules by the work tree's
      // rule and keeps the extras. Its undo walked node_modules (the undo row's .gitignore listed it, but the row tracked
      // files there): past a 60-entry budget refused (link_check_failed), within the default its capture took the 40
      // extras and its reset deleted them, in that second undo row only. Kept out now, so they stay, both ways
      for (const [aid, budgetMax] of [['fr4', 60], ['fr4b', 0]]) row(aid, async () => {
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
        A.ok(!!(u && u.preRestoreId) && !(await tree(aid, u.preRestoreId)).some((p) => /^node_modules\/extra\//.test(p)), aid + ': the undo\'s capture left them out too (its row\'s .gitignore lists node_modules)');
      }, true);
    }
    row('fr5', async () => {
      // fr5 (Codex A4-2D1-02): a rewind across 33 changed .gitignore files (the root's lists node_modules, 32 small
      // folders have one each), 150 node_modules files no capture took, budget 120. Past 32 the rewind's walk dropped the
      // target's rules, so the undo walked node_modules by the work tree's rules alone and was refused (link_check_failed).
      // Every changed .gitignore is read now. The 32 small rules are plain names (they were `*.tmp`, a glob: since undo
      // review 2 a rewind that changes one is refused)
      const st = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 120 });
      const aid = 'fr5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{}\n');
      const t0 = await st.snapshot(aid, { runId: 'r', turn: 0, label: 'package.json only' });
      put(path.join(wt, '.gitignore'), 'node_modules\n');
      for (let i = 0; i < 32; i++) put(path.join(wt, 'd' + i, '.gitignore'), 'tmp\n');
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
    }, true);
    if (isWin || process.platform === 'darwin') row('fr6', async () => {
      // fr6 (r3 minor): the target tracks Node_Modules/foo below its node_modules rule; the folder on disk is spelled
      // node_modules and holds the person's foo no capture took. Where the file system folds case, the target holds that
      // path; a case-sensitive lookup said it held nothing there, kept the folder out of the capture, and refused the
      // rewind ('uncaptured_in_path'). Its foo was taken by name, and the undo brought it back, until undo review 11: any path a
      // tree spells otherwise than the disk refuses a rewind now, for that reason and last of its checks (the store's SPELLED)
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
      A.ok(!!(t && t.created && s3 && s3.created) && (await tree(aid, t.id)).includes('Node_Modules/foo'), 'fixture: the target spells it Node_Modules/foo');
      put(path.join(wt, 'node_modules', 'foo'), 'PERSON foo, no capture took this\n');
      await refusedClean(store, aid, wt, t.id, 'uncaptured_check_failed', /^"node_modules" is spelled "Node_Modules" in the restore point/, 'fr6, a rewind where only the case of a folder differs');
    }, true); else console.log('[skip] fr6: this file system does not fold case');
    await runRows(first.concat(rows), () => ({}));
    {
      // this file passes test/slow.list's 40 s rule (slow.list says what it takes, under what load and when); listed there, a gate gives it
      // 600 s, not 120 s. Its rows were test/checkpoint-links.test.js's row 20 until undo review 12's fix, so that file keeps room under its cap
      const steps = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(steps('slow.list').includes('test/checkpoint-undo-closure.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
      A.eq([steps('fast.list').includes('test/checkpoint-undo-closure.test.js'), steps('http.list').includes('test/checkpoint-undo-closure.test.js')], [true, false], 'and a step of the fast gate, as test/checkpoint-links.test.js is');
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
  A.report('checkpoint-undo-closure.test');
})().catch((e) => { console.log('FAIL: checkpoint-undo-closure.test threw — ' + (e && e.stack || e)); process.exit(1); });
