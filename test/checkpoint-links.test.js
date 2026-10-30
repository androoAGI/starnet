/* node test/checkpoint-links.test.js — a checkpoint never reads, writes or deletes THROUGH a link (lane checkpoint-links,
   review round 1, 2026-10-30; sidecar/checkpoint-store.js, the header's LINKS).

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

   Every row below runs against a REAL temp work tree and REAL git. Fixtures: junctions (Windows) or directory symlinks
   (POSIX) made only inside this test's own os.tmpdir() folder, pointing only at sibling folders it made; removed with
   `cmd /c rmdir` (Windows) / unlink before the folder is deleted. A mount point needs administrator rights to make, so
   section 8 drives the classification through an injected fs that reports an entry exactly as libuv reports a volume
   mount point (a reparse point in the listing, a plain folder to lstat).

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
   PRE-EXISTING (the lane did not worsen them; the rows here pin the fix): A, B, C', E, F above; P8 (trunk d5024f5a
   emptied the same folder, having also captured it) and the P1 shape of the clean (trunk removed the same folder); and
   the pre-admission snapshots test/checkpoint-admission.test.js covers. Not covered here: the SSH tar engine
   (environment.js states its scope: links are archived as links; a mount inside the remote root is documented, not
   fixed). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { readSidecarSource, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

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
      A.ok(isLink(path.join(wtB, 'd')) && isLink(path.join(wtB, 'L')), 'neither reset nor clean removed or entered a link');
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
      A.ok(s1 && !tree(aid, s1.id).some((p) => p.startsWith('node_modules/')), 'the next capture drops what the old index tracked behind the link');
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
      A.ok(isLink(path.join(wt, 'jn')), 'clean kept the re-included link (it was never captured)');
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
      const src = readSidecarSource();
      A.ok(/THE SSH CHECKPOINT ENGINE AND LINKS/.test(src) && /tar -cf ' \+ quote\(archive\)/.test(env) && !/tar -[a-zA-Z]*h|--dereference/.test(env), 'the SSH engine states its link scope, and its tar never dereferences a link');
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
      // the same for a folder the walk prunes (an ignored build/) and an embedded repository: each is listed in full on demand
      const aid = 'r2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'build'), 'build was a file\n');
      put(path.join(wt, 'proj'), 'proj was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build and proj are files' });
      fs.unlinkSync(path.join(wt, 'build'));
      fs.unlinkSync(path.join(wt, 'proj'));
      put(path.join(wt, '.gitignore'), 'build/\n');
      put(path.join(wt, 'build', 'out.txt'), 'built\n');
      const outB2 = outside('outB2', { 'b.txt': 'OUTSIDE-B2\n' }), outP2 = outside('outP2', { 'p.txt': 'OUTSIDE-P2\n' });
      link(outB2, path.join(wt, 'build', 'jl'));
      put(path.join(wt, 'proj', 'f.txt'), 'f\n');
      gitInit(path.join(wt, 'proj'));
      link(outP2, path.join(wt, 'proj', 'jl'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'an ignored build/ and a cloned proj/' });
      A.eq(s1 ? tree(aid, s1.id) : [], ['.gitignore', 'own.txt', 'proj'], 'fixture: build/ is ignored and proj/ is one gitlink');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning an ignored folder or an embedded repository that holds a link back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'build' && h.link === 'build/jl') && named.some((h) => h.path === 'proj' && h.link === 'proj/jl'), 'the links in both are found and named');
      A.eq(listing(outB2), { 'b.txt': 'OUTSIDE-B2\n' }, 'the folder behind the ignored link is whole');
      A.eq(listing(outP2), { 'p.txt': 'OUTSIDE-P2\n' }, 'the folder behind the link in the embedded repository is whole');
    }

    // ================= 12. restore's CLEAN keeps every link and never-captured folder, whatever the target's .gitignore says =================
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
      A.ok(isLink(path.join(wt, 'jn')), 'clean kept the link that .gitignore re-includes (it used to unlink it)');
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
