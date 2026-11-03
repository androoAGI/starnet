/* test/helpers/checkpoint-rows.js — how the lane checkpoint-links' nine fast-gate files (test/checkpoint-links.test.js,
   test/checkpoint-undo-closure.test.js, test/checkpoint-undo.test.js, test/checkpoint-undo-gitlinks.test.js, test/checkpoint-undo-reads.test.js, test/checkpoint-undo-older.test.js,
   test/checkpoint-undo-case.test.js, test/checkpoint-undo-folders.test.js, test/checkpoint-undo-held.test.js) start Git and run their rows, so their minutes fit
   test:fast's deadline and each step's 600 s (undo review 6's laws BLOCKER and MAJOR; test/slow.list says what they take), and how
   test/checkpoint-store.test.js and test/checkpoint-store-capped.test.js start Git since undo review 12 (its laws BLOCKER: the blocking start
   cut checkpoint-store off at its 600 s).

   HOW GIT IS STARTED: as the store's own runner starts it, stdin ignored, stdout and stderr piped, without blocking, so
   rows wait for Git side by side; and on Windows with no console of its own (`detached`: DETACHED_PROCESS). With every
   stdio piped, windowsHide makes libuv pass CREATE_NO_WINDOW, and Windows then starts a console host beside every such
   Git, a second process for each launch: 210 ms a launch against 81 ms at 100% CPU, another gate and busy threads on the
   box (2026-11-01, `git ls-files`, four at a time). Git reads no console here, so it answers the same. On POSIX nothing
   changes: no console, and no `detached` here (the store's runner detaches its Git itself there: runProcess).

   THE ROWS run POOL at a time: a row is an async function of its own kit. Each row owns its agent id, work tree and
   outside folders, and the store serializes one agent's operations, never two agents', so none reads another's state
   or timing: reversed, shuffled, and 2 or 8 at a time, each file gave the same assertions (2026-11-01). One that throws
   is a failure of that row alone. Eight since undo review 11, whose rows would have taken checkpoint-undo-reads past its
   step's 300 s at four: 243 s against 303 s, the box at 82-96% (2026-11-02; test/slow.list says what each step takes). */
'use strict';
const A = require('../_assert.js');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const LAUNCH = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: isWin };
const OUT_MAX = 64 << 20;
const POOL = 8;

// one Git launch -> { code, stdout, stderr }: its exit code, -1 when Git could not run, was killed or wrote past OUT_MAX, as the
// store's runner answers (1 is an answer of Git's own: check-ignore's none ignored, grep's no line)
function launch(args, cwd) {
  return new Promise((resolve) => {
    const out = [], err = [];
    let size = 0, over = false, settled = false, child;
    const done = (code, why) => {
      if (settled) return;
      settled = true;
      resolve({ code: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + (why ? String(why) : '') });
    };
    try { child = spawn('git', args, Object.assign({ cwd: cwd || process.cwd() }, LAUNCH)); }
    catch (e) { done(-1, (e && e.message) || e); return; }
    child.stdout.on('data', (b) => { size += b.length; if (size <= OUT_MAX) out.push(b); else if (!over) { over = true; child.kill(); } });
    child.stderr.on('data', (b) => { err.push(b); });
    child.on('error', (e) => done(-1, (e && e.message) || e));
    child.on('close', (code) => done(over || typeof code !== 'number' ? -1 : code));
  });
}
// the store's Git, no output limit: { code, stdout, stderr }, the exit code (-1 when Git could not run); no stdin
function runGit(args, opts) {
  return launch(args, opts && opts.cwd).then((r) => (r.code === 0 ? { code: 0, stdout: r.stdout, stderr: '' } : r));
}
// Git on a fixture's own terms, never the store's call: its output, or a throw on a non-zero exit, as execFileSync gave
function gitRun(args, opts) {
  return launch(args, opts && opts.cwd).then((r) => {
    if (r.code !== 0) throw Object.assign(new Error('Command failed: git ' + args.join(' ') + '\n' + r.stderr), { status: r.code, stdout: r.stdout, stderr: r.stderr });
    return r.stdout;
  });
}
// the spawn to hand the store's own runner (makeCheckpointGitRunner), so its Git starts the same way
const launchSpawn = (file, argv, options) => spawn(file, argv, isWin ? Object.assign({}, options, { detached: true }) : options);
async function runRows(rows, kit) {
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      try { await r.fn(kit()); } catch (e) { A.ok(false, r.name + ' threw — ' + (e && e.stack || e)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, rows.length) }, worker));
}
module.exports = { runGit, gitRun, launchSpawn, runRows, POOL };
