/* node test/shell-local-program.test.js — A LOCAL PROGRAM IS JUDGED BY WHAT IT IS, NOT HOW IT IS SPELLED (GitHub #167, #163).
   On Windows a head spelled `x.exe` or `.\x.exe` is read from its own PE header: a console program runs under the same
   floors as its bare spelling, a GUI one is refused, and anything unproven stays refused. An in-memory file system and
   path.win32 keep the Windows rows real on every platform; the last block reads real programs where they exist.
   Set-ExecutionPolicy passes only in the plain -Scope Process shape. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { inputIsolationRisk, commandSafetyRisk } = require('../sidecar/tools/builtin/shell.js');

// A minimal PE image: the DOS stub's e_lfanew, the signature, the optional header's magic and the Subsystem field.
function pe(subsystem, magic) {
  const b = Buffer.alloc(0x80 + 4 + 20 + 70);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(magic || 0x20b, 0x80 + 24);
  b.writeUInt16LE(subsystem, 0x80 + 24 + 68);
  return b;
}
const CONSOLE = pe(3), GUI = pe(2);

function memFs(files) {
  const opened = new Map();
  let next = 10;
  const key = f => String(f).toLowerCase();
  const has = f => Object.prototype.hasOwnProperty.call(files, key(f));
  const enoent = f => Object.assign(new Error('ENOENT ' + f), { code: 'ENOENT' });
  return {
    statSync(f) { if (!has(f)) throw enoent(f); return { isFile: () => true, isDirectory: () => false, size: files[key(f)].length }; },
    existsSync: has,
    readFileSync(f) { if (!has(f)) throw enoent(f); return files[key(f)]; },
    readdirSync() { return []; },
    openSync(f) { if (!has(f)) throw enoent(f); opened.set(next, files[key(f)]); return next++; },
    readSync(fd, buf, off, len, at) { return opened.get(fd).copy(buf, off, at, at + len); },
    closeSync(fd) { opened.delete(fd); },
    openCount: () => opened.size
  };
}
const cwd = 'C:\\proj';
const lower = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const memory = memFs(lower({
  'C:\\proj\\tools\\venv\\Scripts\\python.exe': CONSOLE,
  'C:\\proj\\tools\\app\\game.exe': GUI,
  'C:\\proj\\tools\\pe32.exe': pe(3, 0x10b),
  'C:\\proj\\tools\\empty.exe': Buffer.alloc(0),
  'C:\\proj\\tools\\text.exe': Buffer.from('not a program'),
  'C:\\proj\\tools\\native.exe': pe(1),
  'C:\\proj\\shadow.exe': GUI,
  'C:\\bin\\shadow.exe': CONSOLE,
  'C:\\bin\\git.exe': CONSOLE,
  'C:\\bin\\ffmpeg.exe': CONSOLE,
  'C:\\bin\\powershell.exe': CONSOLE,
  'C:\\bin\\python.exe': CONSOLE,
  'C:\\bin\\paint.exe': GUI
}));
const at = { cwd, fs: memory, pathMod: path.win32, isWin: true, dialect: 'cmd', env: { PATH: 'C:\\nowhere;"C:\\bin"' } };
const risk = (c, o) => inputIsolationRisk(c, Object.assign({}, at, o));

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

// ---- GUI programs and the unproven stay refused ----
A.ok(/GUI\/native/.test(risk('tools\\app\\game.exe') || ''), 'a GUI PE is refused as a GUI runtime');
A.ok(/GUI\/native/.test(risk('.\\tools\\app\\game.exe --fullscreen') || ''), 'a GUI PE spelled .\\ is refused');
A.ok(/GUI\/native/.test(risk('paint.exe') || ''), 'a GUI PE on PATH is refused');
A.ok(/GUI\/native/.test(risk('"C:\\proj\\tools\\app\\game.exe" --v') || ''), 'a quoted GUI PE is refused');
A.ok(/could not confirm/.test(risk('"C:\\Program Files\\gone\\x.exe" --v') || ''), 'a quoted path with spaces is judged too, not passed by its spelling');
A.ok(/GUI\/native/.test(risk('shadow.exe') || ''), 'a GUI copy in the working folder is not vouched for by a console copy on PATH');
for (const [c, why] of [
  ['missing.exe', 'no such program'],
  ['tools\\missing.exe', 'no such file'],
  ['tools\\empty.exe', 'a zero-byte file, as a store alias reads'],
  ['tools\\text.exe', 'not a PE'],
  ['tools\\native.exe', 'neither console nor GUI'],
  ['.\\run.ps1', 'a .\\ head that is not a .exe'],
  ['%TOOLS%\\git.exe', 'a path that needs expanding']
]) A.ok(/could not confirm/.test(risk(c) || ''), 'unproven stays refused: ' + why);

// ---- the bare spelling's floors still read a console program ----
A.ok(risk('powershell.exe -Command "Start-Process notepad"'), 'a console shell launching a GUI program is still refused');
A.ok(risk('cmd /c paint.exe'), 'a nested GUI program is still refused');
A.ok(risk('git.exe status && paint.exe'), 'a GUI program later in a chain is still refused');
A.ok(risk('msedge.exe --headless=new http://x'), 'a browser is still refused');
A.ok(risk('notepad.exe'), 'a named GUI program is refused without reading a file');
const scripted = memFs(Object.assign(lower({ 'C:\\bin\\python.exe': CONSOLE, 'C:\\proj\\smoke.py': Buffer.from('from selenium import webdriver\n') })));
A.ok(risk('python.exe smoke.py', { fs: scripted }), 'a code file a console interpreter runs is still scanned');

// ---- outside a local Windows shell nothing can be proven ----
A.ok(/could not confirm/.test(risk('git.exe status', { isWin: false }) || ''), 'not Windows: unproven');
A.ok(/could not confirm/.test(risk('git.exe status', { dialect: 'posix' }) || ''), 'a POSIX shell: unproven');
A.ok(/could not confirm/.test(risk('./configure', { isWin: false, dialect: 'posix', pathMod: path.posix }) || ''), 'POSIX ./x: unproven, as before');
A.ok(/could not confirm/.test(inputIsolationRisk('git.exe status', { isWin: true, dialect: 'cmd' }) || ''), 'no injected file system: unproven');
A.eq(memory.openCount(), 0, 'every program file read was closed');

// ---- #163: Set-ExecutionPolicy, the process scope alone ----
const policy = c => commandSafetyRisk(c, { cwd, fs: memory, pathMod: path.win32, isWin: true, dialect: 'powershell', env: at.env });
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
  'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
  'Set-ExecutionPolicy -Scope LocalMachine Bypass',
  'Set-ExecutionPolicy -Scope Process -Scope LocalMachine Bypass',
  'Set-ExecutionPolicy -Sc Process Bypass',
  'Set-ExecutionPolicy -Scope $s Bypass',
  'Set-ExecutionPolicy @p',
  'Set-ExecutionPolicy -Scope Process Bypass -Confirm:$false',
  'Set-ExecutionPolicy -Scope Process Bypass; Set-ExecutionPolicy Unrestricted',
  'powershell -Command "Set-ExecutionPolicy Unrestricted"',
  'Microsoft.PowerShell.Security\\Set-ExecutionPolicy Unrestricted'
]) A.ok(policy(c) && policy(c).kind === 'machine-state', '#163 still refused: ' + c);

// ---- real programs, where this machine has them ----
if (process.platform === 'win32') {
  const real = { cwd: process.cwd(), fs, pathMod: path, dialect: 'cmd' };
  A.eq(inputIsolationRisk('"' + process.execPath + '" --version', real), null, 'the real node.exe is a console program');
  const quotedNoSpace = process.execPath.includes(' ') ? null : inputIsolationRisk(process.execPath + ' --version', real);
  A.eq(quotedNoSpace, null, 'the real node.exe by its full path passes');
  const explorer = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
  const write = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'charmap.exe');
  if (fs.existsSync(write)) A.ok(/GUI\/native/.test(inputIsolationRisk(write, real) || ''), 'the real charmap.exe is a GUI program');
  if (fs.existsSync(explorer)) A.ok(inputIsolationRisk(explorer, real), 'the real explorer.exe is refused');
}
A.report('shell-local-program.test');
