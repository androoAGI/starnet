/* node test/shell-input-isolation.test.js — escape regression for the 2026-07-12 FPS incident.
   A task may build an input-capturing game, but it may not launch its own browser runner on the
   user's interactive desktop. Local UI/game checks must use browser.test_* (headless CDP with
   in-page pointer-lock emulation). Pure/temporary-fixture checks; no browser or input is touched. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inputIsolationRisk, makeShellTool } = require('../sidecar/tools/builtin/shell.js');

function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-input-floor-'));
try {
  put(root, 'src/game.js', 'canvas.requestPointerLock();\n');
  put(root, 'scripts/runtime-smoke.mjs', "import puppeteer from 'puppeteer-core';\nawait puppeteer.launch({headless:true});\n");
  put(root, 'scripts/smoke.py', 'from selenium import webdriver\n');
  put(root, 'scripts/smoke.ts', "import puppeteer from 'puppeteer-core';\n");
  put(root, 'scripts/smoke.cmd', '@node scripts\\runtime-smoke.mjs\n');
  put(root, 'scripts/native-input.ps1', 'Add-Type "[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x,int y);"\n');
  put(root, 'package.json', JSON.stringify({ scripts: {
    smoke: 'node scripts/runtime-smoke.mjs',
    pySmoke: 'python scripts/smoke.py',
    wrap: 'cmd /c scripts/smoke.cmd',
    check: 'node scripts/unit.mjs',
    open: 'vite --open'
  } }));
  put(root, 'scripts/unit.mjs', 'console.log("unit only")\n');

  A.ok(inputIsolationRisk('msedge --headless=new --mute-audio http://127.0.0.1:5173', { cwd: root, fs, pathMod: path }), 'direct headless browser launch is refused; built-in CDP owns browsers');
  A.ok(inputIsolationRisk('node scripts/runtime-smoke.mjs', { cwd: root, fs, pathMod: path }), 'Puppeteer smoke over an input-capturing game is refused');
  A.ok(inputIsolationRisk('npm run smoke', { cwd: root, fs, pathMod: path }), 'npm script indirection cannot hide the unsafe browser smoke');
  A.ok(inputIsolationRisk('npm run check && npm run smoke', { cwd: root, fs, pathMod: path }), 'a later unsafe command in a chain is still refused');
  A.ok(inputIsolationRisk('python scripts/smoke.py', { cwd: root, fs, pathMod: path }), 'Python Selenium automation is refused');
  A.ok(inputIsolationRisk('npm run pySmoke', { cwd: root, fs, pathMod: path }), 'npm-to-Python indirection is refused');
  A.ok(inputIsolationRisk('cmd /c scripts/smoke.cmd', { cwd: root, fs, pathMod: path }), 'cmd wrapper indirection is refused');
  A.ok(inputIsolationRisk('npm run wrap', { cwd: root, fs, pathMod: path }), 'npm-to-cmd-to-Puppeteer indirection is refused');
  A.ok(inputIsolationRisk('bun scripts/smoke.ts', { cwd: root, fs, pathMod: path }), 'Bun browser automation is refused');
  A.ok(inputIsolationRisk('deno run scripts/smoke.ts', { cwd: root, fs, pathMod: path }), 'Deno browser automation is refused');
  A.ok(inputIsolationRisk('electron .', { cwd: root, fs, pathMod: path }), 'Electron GUI launch is refused for an input-capturing app');
  A.ok(inputIsolationRisk('cargo run', { cwd: root, fs, pathMod: path }), 'native GUI runtime launch is refused for an input-capturing app');
  A.ok(inputIsolationRisk('.\\dist\\game.exe', { cwd: root, fs, pathMod: path }), 'a built local executable cannot run on the interactive desktop');
  A.ok(inputIsolationRisk('game.exe', { cwd: root, fs, pathMod: path }), 'a bare Windows executable cannot run on the interactive desktop');
  A.ok(inputIsolationRisk('.\\dist\\game', { cwd: root, fs, pathMod: path }), 'PATHEXT/extensionless local programs cannot bypass the floor');
  A.ok(inputIsolationRisk('rundll32 game.dll,Run', { cwd: root, fs, pathMod: path }), 'DLL entrypoints cannot run on the interactive desktop');
  A.ok(inputIsolationRisk('python smoke.py', { cwd: path.join(root, 'scripts'), fs, pathMod: path }), 'capture scan follows a subdirectory cwd back to the project root');

  put(root, 'package.json', JSON.stringify({ scripts: {
    smoke: 'node scripts/unit.mjs',
    presmoke: 'node scripts/runtime-smoke.mjs',
    check: 'node scripts/unit.mjs',
    open: 'vite --open'
  } }));
  A.ok(inputIsolationRisk('npm run smoke', { cwd: root, fs, pathMod: path }), 'npm pre/post lifecycle hooks cannot hide browser automation');
  A.ok(inputIsolationRisk('npm run smoke', { cwd: path.join(root, 'src'), fs, pathMod: path }), 'npm lifecycle inspection follows a subdirectory cwd to its nearest project root');
  A.ok(inputIsolationRisk('powershell -File scripts/native-input.ps1', { cwd: root, fs, pathMod: path }), 'script containing a native cursor API is refused');
  A.ok(inputIsolationRisk('npm run open', { cwd: root, fs, pathMod: path }), 'framework --open indirection is refused');
  A.ok(inputIsolationRisk('python -c "import ctypes; ctypes.windll.user32.BlockInput(True)"', { cwd: root, fs, pathMod: path }), 'Python BlockInput cannot hide behind an inline interpreter');
  A.ok(inputIsolationRisk('node -e "require(\'child_process\').execSync(\'powershell LockWorkStation\')"', { cwd: root, fs, pathMod: path }), 'inline Node cannot lock the user session');
  A.ok(inputIsolationRisk('powershell -Command "Add-Type SetWindowsHookEx"', { cwd: root, fs, pathMod: path }), 'global input hooks are refused');
  A.ok(inputIsolationRisk('powershell -Command "Invoke-Expression $payload"', { cwd: root, fs, pathMod: path }), 'opaque PowerShell evaluation is refused');

  // These are new commands in the supplied directory, like shell.exec/verify,
  // not text typed into a running terminal whose cwd may have changed.
  A.eq(inputIsolationRisk('npm run check', { cwd: root, exactCwd: true, fs, pathMod: path }), null, 'ordinary unit checks stay allowed');
  A.eq(inputIsolationRisk('npm run build', { cwd: root, exactCwd: true, fs, pathMod: path }), null, 'ordinary build stays allowed');
  A.eq(inputIsolationRisk('curl http://127.0.0.1:5173/', { cwd: root, exactCwd: true, fs, pathMod: path }), null, 'HTTP health probes stay allowed');
  A.eq(inputIsolationRisk('echo SetCursorPos is forbidden', { cwd: root, fs, pathMod: path }), null, 'API words as inert echo arguments do not false-trip');

  // Issue #50: GUI runtimes are judged as launched PROGRAMS, not as words anywhere in a referenced script.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-gui-words-'));
  try {
    const at = { cwd: plain, exactCwd: true, fs, pathMod: path };
    put(plain, 'routine.mjs', '// Re-read before each write so a new pause or external assignment wins.\n' +
      'process.stdout.write("status ok\\n");\nconst width = "calc(100% - 4px)";\nopen(p, { mode: \'write\' });\n');
    A.eq(inputIsolationRisk('node routine.mjs', at), null, 'a comment/identifier/string containing "write" or "calc" does not refuse a Node routine (#50)');
    A.eq(inputIsolationRisk('echo write', at), null, 'a GUI program name as an inert echo argument does not false-trip');
    A.eq(inputIsolationRisk('git commit -m "write notepad docs"', at), null, 'a commit message naming a GUI program is data');

    put(plain, 'launch-notepad.mjs', "import { spawn } from 'node:child_process';\nspawn('notepad', ['notes.txt']);\n");
    put(plain, 'launch-electron.js', "require('child_process').execSync(`electron .`);\n");
    put(plain, 'launch-calc.py', 'import os\nos.system("calc")\n');
    put(plain, 'launch-write.mjs', "spawn('C:\\\\Windows\\\\write.exe');\n");
    put(plain, 'launch.cmd', '@echo off\nnotepad notes.txt\n');
    put(plain, 'launch.ps1', 'Start-Process calc\n');
    put(plain, 'package.json', JSON.stringify({ scripts: { desktop: 'cross-env NODE_ENV=dev electron .', dev: 'concurrently "vite" "electron ."' } }));
    A.ok(inputIsolationRisk('node launch-notepad.mjs', at), 'a script that spawns notepad is still refused');
    A.ok(inputIsolationRisk('node launch-electron.js', at), 'a script that execs electron is still refused');
    A.ok(inputIsolationRisk('python launch-calc.py', at), 'os.system("calc") is still refused');
    A.ok(inputIsolationRisk('node launch-write.mjs', at), 'an explicit write.exe launch is still refused');
    A.ok(inputIsolationRisk('cmd /c launch.cmd', at), 'a batch file launching notepad is still refused');
    A.ok(inputIsolationRisk('powershell -File launch.ps1', at), 'a PowerShell script starting calc is still refused');
    A.ok(inputIsolationRisk('npm run desktop', at), 'an npm script launching electron behind cross-env is still refused');
    A.ok(inputIsolationRisk('npm run dev', at), 'concurrently "electron ." is still refused');
    for (const c of ['notepad x.txt', 'write foo.txt', 'calc', 'npx electron .', 'cmd /c notepad', 'powershell -Command "Start-Process calc"', 'java -jar app.jar', 'dotnet run',
      'node -e "require(\'child_process\').exec(\'notepad\')"']) {
      A.ok(inputIsolationRisk(c, at), 'direct GUI runtime launch is still refused: ' + c);
    }
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }

  const ordinary = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-browser-safe-'));
  try {
    put(ordinary, 'src/app.js', 'document.body.textContent = "hello";\n');
    put(ordinary, 'scripts/smoke.mjs', "import puppeteer from 'puppeteer-core';\nawait puppeteer.launch({headless:true});\n");
    A.ok(inputIsolationRisk('node scripts/smoke.mjs', { cwd: ordinary, fs, pathMod: path }), 'all browser automation routes through StarNet\'s owned synthetic session');
  } finally {
    fs.rmSync(ordinary, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// Tool-boundary integration: unsafe foreground and background commands are rejected before
// either the command spawner or background manager receives them.
{
  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-input-tool-'));
  const agentRoot = path.join(toolRoot, 'ag');
  let spawned = 0, backgroundStarted = 0;
  try {
    put(agentRoot, 'src/game.js', 'canvas.requestPointerLock();\n');
    put(agentRoot, 'scripts/smoke.py', 'from selenium import webdriver\n');
    put(agentRoot, 'package.json', JSON.stringify({ scripts: { smoke: 'python scripts/smoke.py' } }));
    const tools = makeShellTool({
      spawn: () => { spawned++; throw new Error('must not spawn'); }, fs, pathMod: path, root: toolRoot, platform: 'win32',
      bg: { start() { backgroundStarted++; return { ok: true, bgId: 'bad' }; }, status() { return []; }, kill() { return { ok: true }; } }
    });
    A.throws(() => tools.execTool.run({ cmd: 'npm run smoke' }, { agentId: 'ag' }), 'unsafe foreground command is refused at shell.exec boundary');
    A.throws(() => tools.execTool.run({ cmd: 'npm run smoke', background: true }, { agentId: 'ag' }), 'unsafe background command is refused at shell.exec boundary');
    A.eq(spawned, 0, 'unsafe command never reaches foreground spawn');
    A.eq(backgroundStarted, 0, 'unsafe command never reaches background manager');
  } finally {
    fs.rmSync(toolRoot, { recursive: true, force: true });
  }
}

A.report('shell-input-isolation.test');
