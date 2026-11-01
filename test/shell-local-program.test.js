/* node test/shell-local-program.test.js — A LOCAL PROGRAM IS JUDGED BY WHAT IT IS, NOT HOW IT IS SPELLED (GitHub #167, #163).
   On Windows a head spelled `x.exe` or `.\x.exe` is read from its own PE header: a console program is judged again under
   its bare spelling, a GUI one is refused, and anything unproven stays refused. An in-memory file system and path.win32
   keep the Windows rows real on every platform; the last block reads real programs where they exist.
   Set-ExecutionPolicy passes only in the plain -Scope Process shape. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { inputIsolationRisk, commandSafetyRisk } = require('../sidecar/tools/builtin/shell.js');

// A PE image big enough that only the field under test can fail: e_lfanew, signature, optional-header magic, Subsystem.
function pe(subsystem, opts) {
  opts = opts || {};
  const b = Buffer.alloc(0x400);
  b.write(opts.mz || 'MZ', 0, 'latin1');
  b.writeUInt32LE(opts.lfanew != null ? opts.lfanew : 0x80, 0x3c);
  b.write(opts.sig || 'PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(opts.magic || 0x20b, 0x80 + 24);
  b.writeUInt16LE(subsystem, 0x80 + 24 + 68);
  return b;
}
const CONSOLE = pe(3), GUI = pe(2);
const denied = code => Object.assign(new Error(code), { code });

function memFs(files, special) {
  const opened = new Map();
  let next = 10;
  const key = f => String(f).toLowerCase();
  const table = {};
  for (const [k, v] of Object.entries(files)) table[key(k)] = v;
  const has = f => Object.prototype.hasOwnProperty.call(table, key(f));
  const touched = [];
  return {
    statSync(f) {
      touched.push(String(f));
      if (special && special[key(f)]) throw denied(special[key(f)]);
      if (!has(f)) throw denied('ENOENT');
      return { isFile: () => true, isDirectory: () => false, size: table[key(f)].length };
    },
    existsSync: has,
    readFileSync(f) { if (!has(f)) throw denied('ENOENT'); return table[key(f)]; },
    readdirSync() { return []; },
    openSync(f) { if (!has(f)) throw denied('ENOENT'); opened.set(next, table[key(f)]); return next++; },
    readSync(fd, buf, off, len, at) { return opened.get(fd).copy(buf, off, at, at + len); },
    closeSync(fd) { opened.delete(fd); },
    openCount: () => opened.size,
    touched
  };
}
const cwd = 'C:\\proj';
const memory = memFs({
  'C:\\proj\\tools\\venv\\Scripts\\python.exe': CONSOLE,
  'C:\\proj\\tools\\app\\game.exe': GUI,
  'C:\\proj\\tools\\pe32.exe': pe(3, { magic: 0x10b }),
  'C:\\proj\\tools\\empty.exe': Buffer.alloc(0),
  'C:\\proj\\tools\\short.exe': Buffer.from('MZ'),
  'C:\\proj\\tools\\nomz.exe': pe(3, { mz: 'XX' }),
  'C:\\proj\\tools\\nosig.exe': pe(3, { sig: 'NOPE' }),
  'C:\\proj\\tools\\nomagic.exe': pe(3, { magic: 0x999 }),
  'C:\\proj\\tools\\farpe.exe': pe(3, { lfanew: 0x7fffffff }),
  'C:\\proj\\tools\\native.exe': pe(1),
  'C:\\proj\\tools\\cargo.exe': CONSOLE,
  'C:\\proj\\tools\\jdk\\java.exe': CONSOLE,
  'C:\\proj\\tools\\twin.exe': CONSOLE,
  'C:\\proj\\tools\\twin.exe.cmd': Buffer.from('@echo'),
  'C:\\proj\\shadow.exe': GUI,
  'C:\\proj\\twobyext.exe.exe': GUI,
  'C:\\proj\\smoke.py': Buffer.from('from selenium import webdriver\n'),
  'C:\\proj\\evil.ps1': Buffer.from('Add-Type "[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x,int y);"\n'),
  'C:\\proj\\plain.py': Buffer.from('print(1)\n'),
  'C:\\bin\\shadow.exe': CONSOLE,
  'C:\\bin\\twobyext.exe': CONSOLE,
  'C:\\bin\\git.exe': CONSOLE,
  'C:\\bin\\ffmpeg.exe': CONSOLE,
  'C:\\bin\\powershell.exe': CONSOLE,
  'C:\\bin\\python.exe': CONSOLE,
  'C:\\bin\\msedge.exe': CONSOLE,
  'C:\\bin\\notepad.exe': CONSOLE,
  'C:\\bin\\paint.exe': GUI,
  'C:\\later\\alias.exe': CONSOLE
}, { 'c:\\store\\alias.exe': 'EACCES' });
const env = { PATH: 'C:\\nowhere;C:\\bin' };
const at = { cwd, exactCwd: true, fs: memory, pathMod: path.win32, isWin: true, dialect: 'cmd', env };
const risk = (c, o) => inputIsolationRisk(c, Object.assign({}, at, o));
const UNPROVEN = /could not confirm/, GUI_RE = /GUI\/native/;

// ---- the reports: console programs run however they are spelled ----
A.eq(risk('tools\\venv\\Scripts\\python.exe -m py_compile scripts\\a.py'), null, '#167: a venv python.exe under a relative path runs');
A.eq(risk('.\\tools\\venv\\Scripts\\python.exe --version'), null, '#167: the same program spelled .\\ runs');
A.eq(risk('C:\\proj\\tools\\venv\\Scripts\\python.exe --version'), null, 'the same program by its full path runs');
A.eq(risk('git.exe status'), null, 'a console program found on PATH runs');
A.eq(risk('ffmpeg.exe -version'), null, '#167: ffmpeg.exe runs');
A.eq(risk('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File mision\\a.ps1 -Etapa Resto'), null, '#167: the reporter\'s powershell.exe -File runs');
A.eq(risk('tools\\pe32.exe --v'), null, 'a 32-bit console PE runs');
A.eq(risk('"C:\\bin\\git.exe" status'), null, 'a quoted console program runs');
A.eq(risk('git.exe status', { dialect: 'powershell' }), null, 'the PowerShell dialect reads the file the same way');
A.eq(risk('tools\\venv\\Scripts\\python.exe plain.py'), null, 'a console interpreter over a harmless code file runs');

// ---- GUI programs are refused ----
A.ok(GUI_RE.test(risk('tools\\app\\game.exe') || ''), 'a GUI PE is refused as a GUI runtime');
A.ok(GUI_RE.test(risk('.\\tools\\app\\game.exe --fullscreen') || ''), 'a GUI PE spelled .\\ is refused');
A.ok(GUI_RE.test(risk('"C:\\proj\\tools\\app\\game.exe" --v') || ''), 'a quoted GUI PE is refused');
A.ok(GUI_RE.test(risk('paint.exe') || ''), 'a GUI PE on PATH is refused');
A.ok(GUI_RE.test(risk('shadow.exe') || ''), 'a GUI copy in the working folder is not vouched for by a console copy on PATH');

// ---- unproven stays refused, and each row fails on its own field ----
for (const [c, why] of [
  ['missing.exe', 'no such program'],
  ['tools\\missing.exe', 'no such file'],
  ['"C:\\Program Files\\gone\\x.exe" --v', 'a quoted path with spaces is judged, not passed by its spelling'],
  ['tools\\empty.exe', 'a zero-byte file'],
  ['tools\\short.exe', 'shorter than a header'],
  ['tools\\nomz.exe', 'no MZ'],
  ['tools\\nosig.exe', 'no PE signature'],
  ['tools\\nomagic.exe', 'an unknown optional header'],
  ['tools\\farpe.exe', 'an e_lfanew past the bound'],
  ['tools\\native.exe', 'neither console nor GUI'],
  ['tools\\twin.exe', 'a PATHEXT copy beside it would run first'],
  ['twobyext.exe', 'a PATHEXT copy in the working folder beats PATH\'s copy'],
  ['.\\run.ps1', 'a .\\ head that is not a .exe'],
  ['%TOOLS%\\git.exe', 'a path that needs expanding'],
  ['tools/venv/Scripts/python.exe --version', 'cmd reads / as a switch']
]) A.ok(UNPROVEN.test(risk(c) || ''), 'unproven: ' + why);

// ---- a network path is never read ----
for (const c of ['//192.0.2.1/share/x.exe', '\\\\192.0.2.1\\share\\x.exe', '"\\\\192.0.2.1\\share\\a b\\x.exe"', '//./pipe/x.exe']) {
  A.ok(UNPROVEN.test(risk(c) || ''), 'network or device path refused: ' + c);
  A.ok(UNPROVEN.test(risk(c, { dialect: 'powershell' }) || ''), 'network or device path refused in PowerShell: ' + c);
}
A.ok(UNPROVEN.test(risk('git.exe status', { env: { PATH: '\\\\192.0.2.1\\tools;C:\\bin' } }) || ''), 'a network PATH entry before the program is not walked');
A.ok(UNPROVEN.test(risk('git.exe status', { cwd: '\\\\192.0.2.1\\share' }) || ''), 'a network working folder is not read');
A.ok(!memory.touched.some(f => /192\.0\.2\.1|pipe/.test(f)), 'no network or pipe path ever reached the file system');

// ---- the file read must be the file run ----
for (const c of [
  'cd sub & git.exe status',
  'cd sub && .\\git.exe status',
  'pushd sub & git.exe status',
  'copy /y gui.exe git.exe & git.exe status',
  'set "PATH=sub;%PATH%"& git.exe status',
  'git status & git.exe status',
  'cmd /c "cd sub & git.exe status"'
]) A.ok(UNPROVEN.test(risk(c) || ''), 'a program after anything else in a chain is unproven: ' + c);
A.eq(risk('cmd /c git.exe status'), null, 'a wrapper that only carries the program is not a chain');
A.eq(risk('powershell -Command "git.exe status"'), null, 'nor is a PowerShell wrapper');
A.ok(UNPROVEN.test(risk('git.exe status', { exactCwd: false }) || ''), 'text typed into a live shell has no known folder');
A.ok(UNPROVEN.test(risk('alias.exe', { env: { PATH: 'C:\\store;C:\\later' } }) || ''), 'an alias first on PATH (EACCES) is not skipped so a later copy can vouch');
A.ok(UNPROVEN.test(risk('git.exe status', { env: { PATH: '"C:\\a;b";C:\\bin' } }) || ''), 'a quoted PATH entry cannot be split safely');

// ---- a console program is judged again under its bare spelling ----
for (const [c, why] of [
  ['powershell.exe -Command "Start-Process notepad"', 'a console shell launching a GUI program'],
  ['cmd /c paint.exe', 'a nested GUI program'],
  ['msedge.exe --headless=new http://x', 'a browser that reads as console'],
  ['notepad.exe', 'a named GUI program that reads as console'],
  ['python.exe smoke.py', 'a code file through a PATH interpreter'],
  ['"python.exe" smoke.py', 'a code file through a quoted interpreter'],
  ['tools\\venv\\Scripts\\python.exe smoke.py', 'a code file through #167\'s own form'],
  ['.\\tools\\venv\\Scripts\\python.exe smoke.py', 'a code file through the .\\ form'],
  ['"powershell.exe" -File evil.ps1', 'a script through a quoted shell'],
  ['tools\\jdk\\java.exe -jar g.jar', 'java -jar under a path'],
  ['tools\\cargo.exe run', 'cargo run under a path']
]) A.ok(risk(c), 'still refused: ' + why);

// ---- outside a local Windows shell nothing can be proven ----
A.ok(UNPROVEN.test(risk('git.exe status', { isWin: false }) || ''), 'not Windows: unproven');
A.ok(UNPROVEN.test(risk('git.exe status', { dialect: 'posix' }) || ''), 'a POSIX shell: unproven');
A.ok(UNPROVEN.test(risk('./configure', { isWin: false, dialect: 'posix', pathMod: path.posix }) || ''), 'POSIX ./x: unproven, as before');
A.ok(UNPROVEN.test(inputIsolationRisk('git.exe status', { isWin: true, dialect: 'cmd', exactCwd: true }) || ''), 'no injected file system: unproven');
A.eq(memory.openCount(), 0, 'every program file read was closed');

// ---- #163: Set-ExecutionPolicy, the process scope alone ----
const policy = c => commandSafetyRisk(c, { cwd, exactCwd: true, fs: memory, pathMod: path.win32, isWin: true, dialect: 'powershell', env });
for (const c of [
  'Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned',
  'Set-ExecutionPolicy RemoteSigned -Scope Process',
  'set-executionpolicy bypass -scope:process -force',
  'powershell -Command "Set-ExecutionPolicy -Scope Process RemoteSigned"'
]) A.eq(policy(c), null, '#163 allowed: ' + c);
for (const c of [
  'Set-ExecutionPolicy Unrestricted',
  'Set-ExecutionPolicy',
  'Set-ExecutionPolicy -Scope Process',
  'Set-ExecutionPolicy Bypass RemoteSigned -Scope Process',
  'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Nonsense',
  'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
  'Set-ExecutionPolicy -Scope LocalMachine Bypass',
  'Set-ExecutionPolicy -Scope Process -Scope LocalMachine Bypass',
  'Set-ExecutionPolicy -Scope Process -Scope:Process Bypass',
  'Set-ExecutionPolicy -Sc Process Bypass',
  'Set-ExecutionPolicy -Scope $s Bypass',
  'Set-ExecutionPolicy @p',
  'Set-ExecutionPolicy -Scope Process Bypass -Confirm:$false',
  'Set-ExecutionPolicy -Scope Process Bypass; Set-ExecutionPolicy Unrestricted',
  'powershell -Command "Set-ExecutionPolicy Unrestricted"',
  'Microsoft.PowerShell.Security\\Set-ExecutionPolicy Unrestricted',
  'Microsoft.PowerShell.Security\\Set-ExecutionPolicy -Scope Process Bypass',
  'powershell -c "Set-ExecutionPolicy Bypass -Scope CurrentUser #\\Set-ExecutionPolicy -Scope Process Bypass" -Force',
  'powershell -c "Set-ExecutionPolicy -Scope Process Bypass;" "Set-ExecutionPolicy Unrestricted -Scope CurrentUser"'
]) A.ok(policy(c) && policy(c).kind === 'machine-state', '#163 still refused: ' + c);

// ---- real programs, where this machine has them ----
if (process.platform === 'win32') {
  const real = { cwd: process.cwd(), exactCwd: true, fs, pathMod: path, dialect: 'cmd' };
  A.eq(inputIsolationRisk('"' + process.execPath + '" --version', real), null, 'the real node.exe is a console program');
  const charmap = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'charmap.exe');
  if (fs.existsSync(charmap)) A.ok(GUI_RE.test(inputIsolationRisk('"' + charmap + '"', real) || ''), 'the real charmap.exe is a GUI program');
}
A.report('shell-local-program.test');
