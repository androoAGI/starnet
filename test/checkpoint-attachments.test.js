/* node test/checkpoint-attachments.test.js - THE RESTORE POINTS NEVER HOLD A DELETED CHAT'S UPLOADS (turn identity commit 12, contract A17 iii).

   An agent's uploads live under its workspace's .attachments/. The shadow git repo behind the restore points snapshots that workspace with
   `git add -A`, so before this rule every upload was copied into a commit that outlives the 50-snapshot window for an idle agent. Real temp
   workspace, real git:

     1. a NEW workspace repo ignores .attachments/ (info/exclude): a snapshot taken with an upload on disk does not hold it, while the rest of the
        workspace is snapshotted as before;
     2. a repo made BEFORE the rule that tracks an upload: the next snapshot adds the exclude and untracks the directory (the history keeps the old
        commits), and forgetAttachments(agent, paths) then replaces the repo by one baseline of the current tree - the upload's bytes are gone from
        the object store, the older rollback points are lost, and the restore list is one row;
     3. forgetAttachments leaves a repo alone whose history holds none of the paths (no reset, same head), and is idempotent;
     4. a path outside .attachments/ is never searched for (the deleted-session call cannot be turned into a wipe of delivered work);
     5. a project root (the Commander's own folder) keeps its own ignore rules: nothing is added to it. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');

let longestCommand = 0;
function runGit(args, opts) {
  longestCommand = Math.max(longestCommand, args.join(' ').length);
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-attach-'));
  const clock = makeClock(1700000000000);
  const aid = 'u1';
  const wt = path.join(root, aid);
  fs.mkdirSync(wt, { recursive: true });
  const P = rel => path.join(wt, rel);
  const write = (rel, body) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), body); };
  const gitDir = path.join(root, '.checkpoints', aid, 'git');
  const git = async args => (await runGit(['--git-dir', gitDir, '--work-tree', wt].concat(args), { cwd: wt }));
  const tracked = async rev => (await git(['ls-tree', '-r', '--name-only', rev || 'HEAD'])).stdout.split('\n').filter(Boolean);
  const hashOf = async rel => (await runGit(['hash-object', P(rel)], { cwd: wt })).stdout.trim();
  const store = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 50 });
  const rows = () => store.list(aid).snapshots;

  try {
    // ---- 1. a new repo ignores the uploads ----
    write('notes.md', 'v1\n');
    write('.attachments/quokka.txt', 'QUOKKA-SECRET-BYTES of a deleted chat\n');
    const s1 = await store.snapshot(aid, { runId: 'r1', turn: 0, label: 'fs.write' });
    A.ok(s1 && s1.created, 'a snapshot was taken with an upload on disk');
    A.eq(await tracked(), ['notes.md'], 'the snapshot holds the workspace file and NOT the upload');
    A.ok(/^\.attachments\/$/m.test(fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')), 'the shadow repo\'s info/exclude names .attachments/');
    A.ok(fs.existsSync(P('.attachments/quokka.txt')), 'the upload itself is untouched on disk');
    write('notes.md', 'v2\n');
    write('.attachments/another.txt', 'a second upload\n');
    const s2 = await store.snapshot(aid, { runId: 'r1', turn: 1, label: 'fs.edit' });
    A.ok(s2 && s2.created && (await tracked()).join() === 'notes.md', 'a later snapshot still holds no upload');

    // ---- 2. a repo made before the rule that tracks an upload ----
    const secretBlob = await hashOf('.attachments/quokka.txt');
    fs.rmSync(path.join(gitDir, 'info', 'exclude'));   // the older repo: no rule
    await git(['add', '-f', '--', '.attachments']);
    const old = await git(['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'snapshot (before the rule)']);
    A.eq(old.code, 0, 'an older commit holding the upload exists');
    A.ok((await tracked()).includes('.attachments/quokka.txt'), 'the older repo tracks the upload');
    A.eq((await git(['cat-file', '-t', secretBlob])).stdout.trim(), 'blob', 'and its bytes are in the object store');
    write('notes.md', 'v3\n');
    const s3 = await store.snapshot(aid, { runId: 'r2', turn: 0, label: 'fs.edit' });
    A.ok(s3 && s3.created, 'the next snapshot works');
    A.eq(await tracked(), ['notes.md'], 'it untracked the directory (the exclude is back, the new commit holds no upload)');
    A.ok((await git(['log', '--all', '--format=%H', '--', '.attachments/quokka.txt'])).stdout.trim().length > 0, 'but the HISTORY still holds the upload');
    A.eq((await git(['cat-file', '-t', secretBlob])).stdout.trim(), 'blob', 'and its bytes are still in the object store');
    const before = rows().length;
    A.ok(before >= 3, 'several rollback points exist: ' + before);
    const out = await store.forgetAttachments(aid, ['.attachments/quokka.txt']);
    A.eq(out, { held: true, reinit: true }, 'forgetAttachments found the upload in the history and replaced the repo');
    A.eq((await git(['log', '--all', '--format=%H', '--', '.attachments/quokka.txt'])).stdout.trim(), '', 'no commit holds the upload any more');
    A.ok((await git(['cat-file', '-t', secretBlob])).code !== 0, 'its bytes are gone from the object store');
    A.eq((await git(['rev-list', '--all', '--count'])).stdout.trim(), '1', 'the repo is one baseline commit');
    A.eq(rows().length, 1, 'the restore list is that one baseline: the older rollback points are lost');
    A.eq(await tracked(), ['notes.md'], 'the baseline holds the workspace and no upload');
    A.ok(/^\.attachments\/$/m.test(fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')), 'the replacement repo ignores uploads too');
    A.eq(fs.readFileSync(P('notes.md'), 'utf8'), 'v3\n', 'the workspace file is as it was');
    A.ok(fs.existsSync(P('.attachments/quokka.txt')), 'the upload file itself is not this call\'s to remove (the attachment-files entry removes it)');

    // ---- 3. nothing held: nothing replaced; idempotent ----
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    A.eq(await store.forgetAttachments(aid, ['.attachments/quokka.txt']), { held: false, reinit: false }, 'a second call finds nothing and replaces nothing');
    A.eq(await store.forgetAttachments(aid, ['.attachments/never-saved.txt']), { held: false, reinit: false }, 'a path no commit ever held replaces nothing');
    A.eq((await git(['rev-parse', 'HEAD'])).stdout.trim(), head, 'the head did not move');

    // ---- 3b. hundreds of uploads do not fit on one command line ----
    /* RED before: every path went on one `git log`. About 600 uploads for one agent passed Windows' limit (spawn ENAMETOOLONG), the search failed, and
       the forget pass failed with it at every retry, so the ledger never settled. */
    const many = Array.from({ length: 1000 }, (_, i) => '.attachments/' + String(i).padStart(8, '0') + '-1111-4111-8111-111111111111.jpg');
    longestCommand = 0;
    A.eq(await store.forgetAttachments(aid, many), { held: false, reinit: false }, '1000 paths no commit holds are searched and replace nothing');
    A.ok(longestCommand > 0 && longestCommand < 30000, 'no single search passes the command-line limit: ' + longestCommand + ' characters');
    A.eq((await git(['rev-parse', 'HEAD'])).stdout.trim(), head, 'and the head did not move');
    fs.rmSync(path.join(gitDir, 'info', 'exclude'));
    await git(['add', '-f', '--', '.attachments']);
    A.eq((await git(['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'snapshot (before the rule)'])).code, 0, 'an older commit holds an upload again');
    A.eq(await store.forgetAttachments(aid, many.concat(['.attachments/quokka.txt'])), { held: true, reinit: true }, 'a path in the last batch is found and the repo is replaced');
    A.eq((await git(['log', '--all', '--format=%H', '--', '.attachments/quokka.txt'])).stdout.trim(), '', 'no commit holds that upload any more');
    A.eq(await store.forgetAttachments('nobody', ['.attachments/x.txt']), { held: false, reinit: false }, 'an agent with no repo is left alone');

    // ---- 4. only uploads are searched for ----
    write('delivered/report.md', 'delivered work\n');
    const s4 = await store.snapshot(aid, { runId: 'r3', turn: 0, label: 'fs.write' });
    A.ok(s4 && s4.created && (await tracked()).includes('delivered/report.md'), 'delivered work is snapshotted');
    const rowsBefore = rows().length;
    A.eq(await store.forgetAttachments(aid, ['delivered/report.md', '../escape', '.attachments/../delivered/report.md']), { held: false, reinit: false }, 'a path outside .attachments/ (or climbing out of it) is not searched for');
    A.eq(rows().length, rowsBefore, 'so no rollback point is lost');
    A.eq(await store.forgetAttachments('bad agent', ['.attachments/x.txt']), { held: false, reinit: false }, 'a bad agent id is refused quietly');

    // ---- 5. a project root keeps its own rules ----
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-attach-proj-'));
    try {
      const scoped = makeCheckpointStore({ fs, pathMod: path, root, runGit, clock, keep: 50, scopeIdOf: p => require('crypto').createHash('sha256').update(String(p)).digest('hex').slice(0, 32), allowWorkTree: () => true });
      fs.mkdirSync(path.join(proj, '.attachments'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.attachments', 'theirs.txt'), 'the Commander\'s own folder named .attachments\n');
      fs.writeFileSync(path.join(proj, 'main.txt'), 'project\n');
      const sp = await scoped.snapshot(aid, { runId: 'r4', turn: 0, label: 'project', workTree: proj, authorizedWorkTree: true });
      A.ok(sp && sp.created, 'a project root snapshot was taken');
      const scopeDirs = fs.readdirSync(path.join(root, '.checkpoints', aid, 'roots'));
      const pgit = path.join(root, '.checkpoints', aid, 'roots', scopeDirs[0], 'git');
      const files = (await runGit(['--git-dir', pgit, '--work-tree', proj, 'ls-tree', '-r', '--name-only', 'HEAD'], { cwd: proj })).stdout.split('\n').filter(Boolean).sort();
      A.eq(files, ['.attachments/theirs.txt', 'main.txt'], 'the Commander\'s own folder is snapshotted whole: the exclude belongs to the agent\'s workspace repo only');
      A.ok(!fs.existsSync(path.join(pgit, 'info', 'exclude')) || !/\.attachments/.test(fs.readFileSync(path.join(pgit, 'info', 'exclude'), 'utf8')), 'and no exclude line was added to that repo');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }

    A.report('checkpoint-attachments');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
