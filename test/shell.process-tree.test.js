/* node test/shell.process-tree.test.js — real foreground abort tree cleanup.

   The shell leader is deliberately separated from a parent Node process and its grandchild. On Windows,
   killing that leader before taskkill inspects `/T` loses the only process-tree root and leaves both Node
   descendants alive. This test owns and reaps only the exact PIDs written by its fixtures. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runCommand } = require('../sidecar/tools/builtin/shell.js');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    } catch (_) { return false; }
  }
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitFor(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  return read();
}

function reap(pid) {
  return new Promise(resolve => {
    if (!alive(pid)) return resolve();
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      return resolve();
    }
    let killer;
    try { killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch (_) { return resolve(); }
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-shell-tree-'));
  const grandFile = path.join(root, 'grand.js');
  const parentFile = path.join(root, 'parent.js');
  const pidFile = path.join(root, 'pids.json');
  let pids = null;
  let runPromise = null;
  let settled = false;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

  fs.writeFileSync(grandFile, "'use strict'; setInterval(() => {}, 1000);\n");
  fs.writeFileSync(parentFile,
    "'use strict';\n" +
    "const fs = require('fs');\n" +
    "const { spawn } = require('child_process');\n" +
    'const grand = spawn(process.execPath, [' + JSON.stringify(grandFile) + "], { stdio: 'ignore' });\n" +
    'fs.writeFileSync(' + JSON.stringify(pidFile) + ", JSON.stringify({ parent: process.pid, grandchild: grand.pid }));\n" +
    'setInterval(() => {}, 1000);\n');

  try {
    const ac = new AbortController();
    const cmd = '"' + process.execPath + '" "' + parentFile + '"';
    runPromise = runCommand({ spawn, cmd, cwd: root, timeoutMs: 30000, maxBytes: 1024, signal: ac.signal, isWin: process.platform === 'win32' });
    runPromise.then(() => { settled = true; }, () => { settled = true; });

    pids = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (_) { return null; }
    }, 5000);
    A.ok(pids && alive(pids.parent), 'parent fixture is alive before abort');
    A.ok(pids && alive(pids.grandchild), 'grandchild fixture is alive before abort');

    ac.abort();
    await waitFor(() => pids && !alive(pids.parent) && !alive(pids.grandchild) && settled, 5000);

    A.eq(alive(pids && pids.parent), false, 'abort reaps the command parent');
    A.eq(alive(pids && pids.grandchild), false, 'abort reaps the command grandchild');
    A.eq(settled, true, 'foreground run settles after abort cleanup');
    A.eq(alive(unrelated.pid), true, 'abort leaves unrelated processes alive');
  } finally {
    unrelated.kill();
    if (pids) {
      await reap(pids.grandchild);
      await reap(pids.parent);
    }
    if (runPromise) await Promise.race([runPromise.catch(() => {}), delay(1000)]);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('shell.process-tree.test');
})().catch(e => { console.log('FAIL: shell.process-tree.test threw — ' + (e && e.stack || e)); process.exit(1); });
