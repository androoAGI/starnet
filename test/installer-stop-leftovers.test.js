'use strict';
/* test/installer-stop-leftovers.test.js — the installer stops what is left running from StarNet's OWN bundled folders,
   and nothing else (src-tauri/installer/hooks.nsh, STARNET_STOP_INSTALL_PROCESSES step 3, `; STARNET_STOP_LEFTOVERS`).

   Steps 1 and 2 stop the shell and the bundled node by exact path. A bundled helper an orphaned OLDER station left behind
   (node-pty's OpenConsole.exe under node_modules) was never stopped, held its own file open, and NSIS stalled on "error
   opening file for writing". This runs THAT EXACT PowerShell line — read out of hooks.nsh, NSIS escapes undone the way
   NSIS undoes them — with the install folder in its environment (as the macro sets it) pointing at a scratch "install
   dir" whose path carries an apostrophe (a quoted literal broke on C:\Users\O'Brien\... before).

   Planted, all running at once:
     - a helper deep in node_modules                          → STOPPED (and named in the install log)
     - an agent-built program in the default WORKSPACES       → untouched (the default install dir holds the workspaces)
     - another app's program in the same folder, top level and in its own subfolder (an install typed into D:\Apps)
                                                              → untouched
     - a program in a PREFIX SIBLING folder (…\StarNet-other) → untouched
   And the line is run BY a process in the install dir, the way the uninstaller runs it IN PLACE
   ($INSTDIR\uninstall.exe, Tauri's "uninstall before installing" page passes _?=): that host must survive the line and
   go on — once from $INSTDIR\uninstall.exe, once from inside node_modules (only the never-stop-my-own-ancestors rule
   keeps that one alive). Windows only (elsewhere it says so and passes). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('./_assert.js');

if (process.platform !== 'win32') { console.log('installer-stop-leftovers.test: Windows only — skipped'); process.exit(0); }
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ROOT = path.join(__dirname, '..');
const nsh = fs.readFileSync(path.join(ROOT, 'src-tauri', 'installer', 'hooks.nsh'), 'utf8').split('\n');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
// a hard link where the volume allows it (no 80 MB copy per planted program), else a copy
function plant(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.linkSync(process.execPath, file); } catch (_) { fs.copyFileSync(process.execPath, file); }
  return file;
}

(async () => {
  const i = nsh.findIndex(l => l.trim() === '; STARNET_STOP_LEFTOVERS');
  A.ok(i >= 0, 'hooks.nsh carries the STARNET_STOP_LEFTOVERS line');
  const m = /-Command "(.*)"'\s*$/.exec(nsh[i + 1] || '');
  A.ok(!!m, 'it runs one PowerShell -Command');
  // NSIS_MAX_STRLEN is 1024: the line, with $R9 expanded to the 64-bit PowerShell path, must fit
  A.ok((nsh[i + 1] || '').length - 3 + 64 < 1024, 'the line fits an NSIS string once $R9 expands: ' + (nsh[i + 1] || '').length);
  // the folder reaches the command through the environment the macro sets just before, never pasted into it
  const set = nsh.slice(Math.max(0, i - 3), i).some(l => /SetEnvironmentVariable\(t "STARNET_INSTALL_DIR", t "\$INSTDIR"\)/.test(l));
  A.ok(set, 'the macro sets STARNET_INSTALL_DIR to $INSTDIR right before it');
  const macro = nsh.slice(nsh.findIndex(l => /^!macro STARNET_STOP_INSTALL_PROCESSES/.test(l)), nsh.findIndex(l => /^!macro NSIS_HOOK_PREINSTALL/.test(l))).join('\n');
  A.ok(macro.indexOf('; STARNET_STOP_LEFTOVERS') > macro.indexOf('Get-Process -Name node'), 'it runs after the shell and the bundled node are stopped, inside the one shared macro');
  const script = m ? m[1].replace(/\$\\'/g, "'").replace(/\$\$/g, '$') : '';
  A.ok(!/\$INSTDIR/.test(script), 'no install path is pasted into the PowerShell text');
  // every folder the sweep names is one the app itself ships (tauri.conf.json bundle.resources targets)
  const own = /\$own=((?:'[^']+',?)+)/.exec(script);
  A.ok(!!own, 'the sweep names its folders in one $own list');
  const targets = new Set(Object.values((conf.bundle && conf.bundle.resources) || {}).map(String));
  for (const f of own ? own[1].split(',').map(x => x.replace(/'/g, '')) : []) A.ok(targets.has(f), 'the sweep\'s folder "' + f + '" is a folder the app ships');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-leftovers-'));
  const instdir = path.join(root, "O'Brien", 'StarNet');
  const started = [];
  try {
    const helper = plant(path.join(instdir, 'node_modules', 'node-pty', 'conpty', 'OpenConsole-stand-in.exe'));
    const workspaceTool = plant(path.join(instdir, 'workspaces', 'default', 'project', 'built-tool.exe'));
    const otherTop = plant(path.join(instdir, 'other-app.exe'));
    const otherSub = plant(path.join(instdir, 'OtherApp', 'other.exe'));
    const sibling = plant(path.join(root, "O'Brien", 'StarNet-other', 'node_modules', 'x', 'node.exe'));
    const hostTop = plant(path.join(instdir, 'uninstall.exe'));
    const hostDeep = plant(path.join(instdir, 'node_modules', 'host', 'uninstall.exe'));
    const idle = ['-e', 'setInterval(function(){}, 1000)'];
    const run = exe => { const c = spawn(exe, idle, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); started.push(c.pid); return c.pid; };
    const pHelper = run(helper), pWorkspace = run(workspaceTool), pTop = run(otherTop), pSub = run(otherSub), pSibling = run(sibling);
    await sleep(600);
    A.ok([pHelper, pWorkspace, pTop, pSub, pSibling].every(alive), 'the planted processes run');

    // the hook line, run BY a process in the install dir (the in-place uninstaller's shape); it must survive and go on
    const hostSrc = "const r=require('child_process').spawnSync(process.env.T_PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',process.env.T_SCRIPT],{encoding:'utf8',timeout:60000});" +
      "process.stdout.write(JSON.stringify({status:r.status,out:String(r.stdout||''),err:String(r.stderr||'').slice(0,300)})+'\\nHOST-WENT-ON\\n');";
    const runHook = (host, dir) => spawnSync(host, ['-e', hostSrc],
      { encoding: 'utf8', timeout: 90000, windowsHide: true, env: Object.assign({}, process.env, { T_PS: PS, T_SCRIPT: script, STARNET_INSTALL_DIR: dir }) });
    const hosted = runHook(hostTop, instdir);
    A.eq(hosted.status, 0, 'the in-place uninstaller ($INSTDIR\\uninstall.exe) survives the line and exits cleanly: ' + String(hosted.stderr || '').slice(0, 200));
    A.ok(/HOST-WENT-ON/.test(hosted.stdout || ''), 'and goes on past it');
    let report = null;
    try { report = JSON.parse(String(hosted.stdout || '').split('\n')[0]); } catch (_) { report = null; }
    A.ok(!!report && report.status === 0, 'the hook line runs cleanly: ' + JSON.stringify(report && report.err));
    A.ok(!!report && report.out.indexOf('StarNet: stopping ' + helper) >= 0, 'each stop is named in the install log: ' + JSON.stringify(report && report.out.slice(0, 300)));
    for (let k = 0; k < 30 && alive(pHelper); k++) await sleep(100);
    A.ok(!alive(pHelper), 'a bundled helper running from deep inside node_modules is stopped');
    A.ok(alive(pWorkspace), 'an agent-built program in the default WORKSPACES is never touched');
    A.ok(alive(pTop), 'another app at the top of a shared install folder is never touched');
    A.ok(alive(pSub), 'another app in its own subfolder of a shared install folder is never touched');
    A.ok(alive(pSibling), 'a process from a PREFIX SIBLING folder (…\\StarNet-other) is never touched');
    A.ok(alive(process.pid), 'nor anything else (this test)');

    const deep = runHook(hostDeep, instdir);
    A.eq(deep.status, 0, 'a host running from INSIDE a swept folder is never stopped by its own line (its ancestors are spared)');
    A.ok(/HOST-WENT-ON/.test(deep.stdout || ''), 'and it goes on past it');

    const empty = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_INSTALL_DIR: '' }), timeout: 60000 });
    A.eq(empty.status, 0, 'with no folder named it does nothing and exits cleanly');
    A.ok(alive(pWorkspace) && alive(pSibling), 'and stops nothing');
  } finally {
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    await sleep(300);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('installer-stop-leftovers.test');
})().catch(e => { console.error(e); process.exit(1); });
