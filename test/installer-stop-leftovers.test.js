'use strict';
/* test/installer-stop-leftovers.test.js — the installer stops EVERY process running from the install directory, and
   nothing outside it (src-tauri/installer/hooks.nsh, STARNET_STOP_INSTALL_PROCESSES step 3, `; STARNET_STOP_LEFTOVERS`).

   Steps 1 and 2 stop the shell and the bundled node by exact path. A bundled helper an orphaned OLDER station left behind
   (node-pty's OpenConsole.exe, any other exe under the install dir) was never stopped, held its own file open, and NSIS
   stalled on "error opening file for writing". This runs THAT EXACT PowerShell line — read out of hooks.nsh, NSIS escapes
   undone the way NSIS undoes them — with the install folder in its environment (as the macro sets it) pointing at a
   scratch "install dir" whose path carries an apostrophe (a quoted literal broke on C:\Users\O'Brien\... before). It
   plants a runtime and a renamed helper running from there, plus a bystander running from a PREFIX SIBLING
   (…\StarNet-other\) and this test's own node: the two planted ones are stopped, the bystander and this test are not.
   Windows only (elsewhere it says so and passes). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('./_assert.js');

if (process.platform !== 'win32') { console.log('installer-stop-leftovers.test: Windows only — skipped'); process.exit(0); }
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const nsh = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'installer', 'hooks.nsh'), 'utf8').split('\n');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }

(async () => {
  const i = nsh.findIndex(l => l.trim() === '; STARNET_STOP_LEFTOVERS');
  A.ok(i >= 0, 'hooks.nsh carries the STARNET_STOP_LEFTOVERS line');
  const m = /-Command "(.*)"'\s*$/.exec(nsh[i + 1] || '');
  A.ok(!!m, 'it runs one PowerShell -Command');
  // the folder reaches the command through the environment the macro sets just before, never pasted into it
  const set = nsh.slice(Math.max(0, i - 3), i).some(l => /SetEnvironmentVariable\(t "STARNET_INSTALL_DIR", t "\$INSTDIR"\)/.test(l));
  A.ok(set, 'the macro sets STARNET_INSTALL_DIR to $INSTDIR right before it');
  const macro = nsh.slice(nsh.findIndex(l => /^!macro STARNET_STOP_INSTALL_PROCESSES/.test(l)), nsh.findIndex(l => /^!macro NSIS_HOOK_PREINSTALL/.test(l))).join('\n');
  A.ok(macro.indexOf('; STARNET_STOP_LEFTOVERS') > macro.indexOf('Get-Process -Name node'), 'it runs after the shell and the bundled node are stopped, inside the one shared macro');
  const script = m ? m[1].replace(/\$\\'/g, "'").replace(/\$\$/g, '$') : '';
  A.ok(!/\$INSTDIR/.test(script), 'no install path is pasted into the PowerShell text');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-leftovers-'));
  const instdir = path.join(root, "O'Brien", 'StarNet');
  const sibling = path.join(root, "O'Brien", 'StarNet-other');
  const started = [];
  try {
    fs.mkdirSync(path.join(instdir, 'node_modules', 'node-pty', 'conpty'), { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const runtime = path.join(instdir, 'node.exe');
    const helper = path.join(instdir, 'node_modules', 'node-pty', 'conpty', 'OpenConsole-stand-in.exe');
    const outside = path.join(sibling, 'node.exe');
    for (const f of [runtime, helper, outside]) fs.copyFileSync(process.execPath, f);
    const idle = ['-e', 'setInterval(function(){}, 1000)'];
    const run = exe => { const c = spawn(exe, idle, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); started.push(c.pid); return c.pid; };
    const pRuntime = run(runtime), pHelper = run(helper), pOutside = run(outside);
    await sleep(600);
    A.ok([pRuntime, pHelper, pOutside].every(alive), 'the planted processes run');

    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_INSTALL_DIR: instdir }), timeout: 60000 });
    A.eq(r.status, 0, 'the hook line runs cleanly: ' + String(r.stderr || '').trim().slice(0, 300));
    for (let k = 0; k < 30 && (alive(pRuntime) || alive(pHelper)); k++) await sleep(100);
    A.ok(!alive(pRuntime), 'a runtime running from the install dir is stopped');
    A.ok(!alive(pHelper), 'a bundled helper running from deep inside the install dir is stopped');
    A.ok(alive(pOutside), 'a process from a PREFIX SIBLING folder (…\\StarNet-other) is never touched');
    A.ok(alive(process.pid), 'nor anything else (this test)');

    const empty = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_INSTALL_DIR: '' }), timeout: 60000 });
    A.eq(empty.status, 0, 'with no folder named it does nothing and exits cleanly');
    A.ok(alive(pOutside), 'and stops nothing');
  } finally {
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    await sleep(300);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('installer-stop-leftovers.test');
})().catch(e => { console.error(e); process.exit(1); });
