/* node test/shell-local-program.test.js — A LOCAL PROGRAM IS JUDGED BY WHAT IT IS, NOT HOW IT IS SPELLED (GitHub #167, #163).
   On Windows a head spelled `x.exe` or `.\x.exe` is read from its own PE header: a console program is judged again under
   its bare spelling, a GUI one is refused, and anything unproven stays refused. An in-memory file system and path.win32
   keep the Windows rows real on every platform; the last block reads real programs where they exist.
   Set-ExecutionPolicy passes only in the plain -Scope Process shape. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
// loadShell(): the guard under test, or the one SHELL_GUARD_CONTROL names (the proof that a new row fails against the old guard)
const { inputIsolationRisk, commandSafetyRisk } = require('./helpers/shell-guard-fixture').loadShell();

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

function memFs(files, special, folders) {
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
      const folder = (folders || []).includes(key(f));
      return { isFile: () => !folder, isDirectory: () => folder, size: table[key(f)].length };
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
  'C:\\bin\\node.exe': CONSOLE,
  'C:\\bin\\ffmpeg.exe': CONSOLE,
  'C:\\bin\\powershell.exe': CONSOLE,
  'C:\\bin\\python.exe': CONSOLE,
  'C:\\bin\\msedge.exe': CONSOLE,
  'C:\\bin\\notepad.exe': CONSOLE,
  'C:\\bin\\paint.exe': GUI,
  'C:\\later\\alias.exe': CONSOLE,
  'C:\\proj\\pair.exe': CONSOLE,
  'C:\\bin\\pair.exe': GUI,
  'C:\\bin\\one.exe': CONSOLE,
  'C:\\later\\one.exe': GUI,
  'C:\\proj\\tools\\zed.exe': CONSOLE,
  'C:\\proj\\tools\\plain': CONSOLE,
  'C:\\proj\\tools\\zed.exe.zzz': Buffer.from('x'),
  'C:\\proj\\tools\\folder.exe': CONSOLE
}, { 'c:\\store\\alias.exe': 'EACCES', 'c:\\afile\\git.exe': 'ENOTDIR' }, ['c:\\proj\\tools\\folder.exe']);
const env = { PATH: 'C:\\nowhere;C:\\bin' };
const at = { cwd, exactCwd: true, fs: memory, pathMod: path.win32, isWin: true, dialect: 'cmd', env };
const risk = (c, o) => inputIsolationRisk(c, Object.assign({}, at, o));
const UNPROVEN = /could not confirm/, GUI_RE = /GUI\/native/;

// ---- the reports: console programs run however they are spelled ----
A.eq(risk('tools\\venv\\Scripts\\python.exe -m py_compile scripts\\a.py'), null, '#167: a venv python.exe under a relative path runs');
A.eq(risk('.\\tools\\venv\\Scripts\\python.exe --version'), null, '#167: the same program spelled .\\ runs');
A.eq(risk('C:\\proj\\tools\\venv\\Scripts\\python.exe --version'), null, 'the same program by its full path runs');
A.eq(risk('git.exe status'), null, 'a console program found on PATH runs');
A.eq(risk('node.exe --version'), null, 'node.exe runs');
A.eq(risk('ffmpeg.exe -version'), null, '#167: ffmpeg.exe runs');
A.eq(risk('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File mision\\a.ps1 -Etapa Resto'), null, '#167: the reporter\'s powershell.exe -File runs');
A.eq(risk('tools\\pe32.exe --v'), null, 'a 32-bit console PE runs');
A.eq(risk('"C:\\bin\\git.exe" status'), null, 'a quoted console program runs');
A.eq(risk('git.exe status', { dialect: 'powershell' }), null, 'the PowerShell dialect reads the file the same way');
A.eq(risk('tools\\venv\\Scripts\\python.exe plain.py'), null, 'a console interpreter over a harmless code file runs');

// ---- the first command typed directly: each limit alone, with no wrapper to refuse it earlier ----
A.ok(UNPROVEN.test(risk('.\\tools\\plain') || ''), 'a console program not spelled .exe is unproven, though its header reads as console');
A.ok(UNPROVEN.test(risk('.\\tools\\pe32') || ''), 'a name that could resolve to the pe32.exe beside it is unproven');
A.ok(UNPROVEN.test(risk('git.exe status `x', { dialect: 'powershell' }) || ''), 'a backtick in a typed command hides what runs');
A.ok(UNPROVEN.test(risk('git.exe status (x)', { dialect: 'powershell' }) || ''), 'a PowerShell (...) argument in a typed command hides what runs');
A.eq(risk('git.exe show (x)', { dialect: 'cmd' }), null, 'a bracket means nothing to cmd');
const chain = n => ['git.exe status'].concat(Array(n - 1).fill('echo a')).join(' & ');
A.eq(risk(chain(8)), null, 'eight commands are within what the parse reads');
A.ok(UNPROVEN.test(risk(chain(9)) || ''), 'past eight commands in all, siblings too, the first one is not proven');
A.ok(UNPROVEN.test(risk('git.exe log | findstr x') || ''), 'a second bare external now needs the same proof as findstr.exe');
A.eq(risk('git.exe log | echo received'), null, 'a typed console command may still feed a builtin pipe');
A.ok(UNPROVEN.test(risk('powershell.exe -c "git status `x"') || ''), 'a first head that re-reads its text: a backtick hides what runs');
A.ok(UNPROVEN.test(risk('powershell.exe -c "git status $(x)"') || ''), 'a first head that re-reads its text: $( hides what runs');
// A deliberate cost: the same proof reads inside quotes. Bare spelling no longer bypasses it.
A.ok(UNPROVEN.test(risk('git.exe commit -m "fix `foo` bug"') || ''), 'a backtick is refused inside quotes too');
A.ok(UNPROVEN.test(risk('git commit -m "fix `foo` bug"') || ''), 'the bare spelling receives the same backtick restriction');
A.eq(risk('git commit -m "fix foo bug"'), null, 'ordinary quoted commit data still runs with proven console context');
A.ok(/shell\.exec.*known working directory.*inside a shell wrapper/.test(risk('cmd /c git.exe status') || ''), 'the refusal names known-cwd shell.exec and says a wrapper is no way round');

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
// No wrapper vouches for a local program: what cmd /c and powershell -c run next cannot be proven from here.
A.ok(UNPROVEN.test(risk('cmd /c git.exe status') || ''), 'a wrapper does not vouch for the program');
A.ok(UNPROVEN.test(risk('powershell -Command "git.exe status"') || ''), 'nor does a PowerShell wrapper');
A.ok(UNPROVEN.test(risk('git.exe status', { exactCwd: false }) || ''), 'text typed into a live shell has no known folder');
A.ok(UNPROVEN.test(risk('alias.exe', { env: { PATH: 'C:\\store;C:\\later' } }) || ''), 'an alias first on PATH (EACCES) is not skipped so a later copy can vouch');
A.ok(UNPROVEN.test(risk('git.exe status', { env: { PATH: '"C:\\a;b";C:\\bin' } }) || ''), 'a quoted PATH entry cannot be split safely');

// ---- no wrapper vouches for a command inside it ----
A.ok(UNPROVEN.test(risk('pwsh -c "git.exe status"') || ''), 'pwsh -c does not vouch');
A.ok(UNPROVEN.test(risk('cmd /d /s /c git.exe status') || ''), 'nor does cmd with its plain flags');
A.ok(UNPROVEN.test(risk('powershell -NoProfile -ExecutionPolicy Bypass -Command "git.exe status"') || ''), 'nor does powershell with its plain flags');
for (const c of [
  'echo git.exe status & git.exe status',
  'cmd /d & git.exe status',
  'cmd < s.bat git.exe & git.exe status',
  'powershell -ExecutionPolicy Bypass -File a.ps1 git.exe & git.exe status',
  'pwsh -WorkingDirectory sub -c .\\git.exe status',
  'cmd /c git.exe status & git.exe status',
  // each of these names the later command in full: a nested head is never proven
  'powershell -File a.ps1 git.exe status & git.exe status',
  'cmd < s.bat git.exe status & git.exe status',
  'call git.exe status',
  'cmd /k git.exe status',
  'pwsh -WorkingDirectory sub -c git.exe status',
  'pwsh -wd sub -c git.exe status',
  'powershell -ExecutionPolicy Nonsense -c git.exe status',
  // mentioned inside a wrapper, but it runs outside it
  'powershell -ep Bypass -c "Copy-Item other.exe git.exe -Force" & git.exe',
  'powershell -NoProfile -ep Bypass -Command "Copy-Item other.exe git.exe -Force" & git.exe',
  'powershell -ep Bypass -c "cd sub; .\\git.exe" & git.exe',
  // another command this parse does not split out
  'cmd /c git.exe status ^& copy /y other.exe git.exe ^& git.exe status',
  'cmd /c git.exe status ^& paint.exe',
  'powershell -c "git.exe status $(Copy-Item other.exe git.exe -Force)"',
  'powershell -c "git.exe status (Copy-Item other.exe git.exe -Force)"',
  'powershell -c "git.exe status `$(Stop-Computer)"',
  // an earlier head that wraps nothing, a verb that is no wrapper, and each hiding form
  'cmd /c "" & git.exe status',
  'bash -c git.exe status',
  'alt\\cmd /c git.exe status',
  'x/cmd /c git.exe status',
  'foo\\powershell -c git.exe status',
  'powershell -c "git.exe status `x"',
  'git.exe status $(x)',
  'powershell -c "git.exe status (x)"',
  'git.exe status ^& x',
  'git.exe status ^| x',
  'git.exe status ^^ x',
  'git.exe status ^< x',
  'git.exe status ^> x',
  // ^" flips the quoting the inner cmd sees
  'git.exe status ^" x',
  'cmd /c git.exe status ^" "& other.exe"',
  'cmd /d /s /c git.exe status ^" "& other.exe"',
  'cmd /c cmd /c git.exe status ^" "& other.exe"',
  'cmd /c git.exe status ^" "& copy /y other.exe git.exe & git.exe status"',
  // the argv join and cmd's quote strip make "data" live, one more reason a wrapper vouches for nothing
  'powershell -c .\\git.exe "; .\\other.exe"',
  'powershell -c git.exe "; Stop-Computer"',
  'powershell -c git.exe "; Set-ExecutionPolicy Unrestricted -Scope CurrentUser"',
  'cmd /c "git.exe" "& copy /y other.exe git.exe & git.exe" x',
  'cmd /c "git.exe" "& paint.exe" x',
  'powershell -c "git.exe status; x"',
  'powershell -c "git.exe log | findstr x"',
  'cmd /c "git.exe status | findstr x"',
  // refused as nested heads, whichever reader sees the .exe
  'alt\\cmd.ex^e /c git.exe status'
]) A.ok(UNPROVEN.test(risk(c) || ''), 'never proven inside a wrapper or a chain: ' + c);
A.ok(UNPROVEN.test(risk('cmd /c "git.exe status 2>&1"') || ''), 'a wrapper does not vouch even for one command with a redirect');
A.eq(risk('git.exe status 2>&1'), null, 'typed directly, a stream redirect is fine');
A.eq(risk('git.exe commit -m "a; b & c"'), null, 'with no wrapper to re-read it, quoted ; and & are data');
A.eq(risk('git.exe status 2>&1 > out.txt'), null, 'a plain redirect is fine');
A.eq(risk('git.exe show HEAD^'), null, 'a caret that escapes nothing is data');
A.eq(risk('C:\\bin\\git.exe status'), null, 'a path spelling is fine when it is the program proven');
A.ok(UNPROVEN.test(risk('powershell -ep Bypass -c "git.exe status"') || ''), 'the short -ep does not earn it either');

// ---- cmd reads its own switches wherever they sit (GitHub #167/#163, review round 7) ----
// Read off the real cmd.exe with harmless echo bodies: the tail is scanned for the first "/" followed by c, k or r (any case),
// through quotes and carets, and everything after it is the command. So /c is not only a token of its own: it is fused with other
// switches (/d/c, /q/s/c, /e:on/c, /t:07/c), with what follows it (/cpaint.exe, /c"paint.exe"), spelled /r, written with a caret
// (/^c) or preceded by junk. Whatever follows is then judged like any other nested command; a switch the guard cannot place
// (built by %VAR% expansion) is refused, never read as absent.
const wrapFs = memFs({
  'C:\\bin\\cmd.exe': CONSOLE, 'C:\\bin\\git.exe': CONSOLE, 'C:\\bin\\powershell.exe': CONSOLE, 'C:\\bin\\forfiles.exe': CONSOLE,
  'C:\\bin\\paint.exe': GUI, 'C:\\proj\\probe.exe': GUI
});
{
  const wrapped = (c, o) => risk(c, Object.assign({ fs: wrapFs }, o));
  const wrappedSafety = (c, o) => commandSafetyRisk(c, Object.assign({}, at, { fs: wrapFs }, o));
  for (const c of [
    'cmd /d/c paint.exe', 'cmd /cpaint.exe', 'cmd /c"paint.exe"', 'cmd /r paint.exe', 'cmd /R paint.exe', 'cmd /rpaint.exe', 'cmd /^c paint.exe',
    'cmd ^/c paint.exe', 'cmd /q/s/c paint.exe', 'cmd /a/c paint.exe', 'cmd /u/c paint.exe', 'cmd /e:on/c paint.exe', 'cmd /e:off /v:on/c paint.exe',
    'cmd /f:off/c paint.exe', 'cmd /t:07/c paint.exe', 'cmd /x/y/c paint.exe', 'cmd /d/k paint.exe', 'CMD /D/K paint.exe', 'CMD.EXE /D/C paint.exe',
    '"C:\\bin\\cmd.exe" /d/c paint.exe', 'cmd /d/c paint', 'cmd /d/c probe', 'cmd /d/c "paint.exe"', 'cmd /d/s/c "paint.exe"', 'cmd /d/c git.exe status',
    'call cmd /d/c paint.exe', 'cmd /c cmd /d/c paint.exe', 'cmd /d/c cmd /r paint.exe', 'powershell -c "cmd /d/c paint.exe"'
  ]) A.ok(UNPROVEN.test(wrapped(c) || ''), 'the nested program is judged, however the switch is spelled: ' + c);
  for (const c of ['cmd %SW% paint.exe', 'cmd /%CD:~0,0%c paint.exe', 'cmd /d %SW%', 'cmd %SW%', 'cmd /d:%X%/c paint.exe']) {
    A.ok(UNPROVEN.test(wrapped(c) || ''), 'a switch built by expansion cannot be placed, so it is refused: ' + c);
  }
  // the text floors read the same nested command: the machine and the screen are as safe behind /d/c as behind /c
  A.eq((wrappedSafety('cmd /d/c shutdown /r /t 0') || {}).kind, 'machine-state', 'shutdown behind /d/c is a machine-state refusal');
  A.eq((wrappedSafety('cmd /cshutdown /r /t 0') || {}).kind, 'machine-state', 'and behind a fused /c');
  A.eq((wrappedSafety('cmd /r start notepad') || {}).kind, 'visible-desktop', 'a window behind /r is a visible-desktop refusal');
  // what cmd runs with no command at all, and the plain bodies, still run
  for (const c of ['cmd /d/c echo hi', 'cmd /cecho hi', 'cmd /c"echo hi"', 'cmd /r echo hi', 'cmd /R echo hi', 'cmd /e:on/c echo hi', 'cmd /d /s /c "echo hi"',
    'cmd /c echo %PATH%', 'cmd /?', 'cmd', 'cmd /d', 'cmd /q /d']) {
    A.eq(wrapped(c), null, 'control, still runs: ' + c);
  }
}
A.eq(wrapFs.openCount(), 0, 'every file read for the switch rows was closed');

// ---- the tail of if, for and forfiles is a command, and is judged like one (GitHub #167/#163, review round 7) ----
// The proof was chosen from the first word of each head, and if / for are cmd's own words, so `if 1==1 probe.exe` was a builtin and
// its program never met the PE header. Read off the real cmd.exe with echo bodies: the body of an if is whatever follows its condition
// (a block, with an else branch after it), the body of a for follows `do`, and `for /f` with a quoted command in its set runs that
// command first. A body is judged as the command it is. Typed first and by itself it earns the same proof as any first command;
// after another command, in a group, or in a wrapper it is unproven, as such a program always was. A header the guard cannot place
// the body after (a comma, a semicolon or a space of odd width in it, a form it does not know) is refused, never read as empty.
{
  const bodies = (c, o) => risk(c, Object.assign({ fs: wrapFs }, o));
  const bodiesSafety = (c, o) => commandSafetyRisk(c, Object.assign({}, at, { fs: wrapFs }, o));
  for (const c of [
    'if 1==1 probe.exe', 'if exist . probe', 'if exist . probe.exe', 'if not exist nosuch probe', 'if /i A==a probe', 'if defined PATH probe.exe',
    'if errorlevel 0 probe', 'if 1 equ 1 probe', 'if cmdextversion 2 probe.exe', 'if "a"=="a" probe.exe', 'if a == a probe.exe', 'if a== a probe.exe',
    'if a ==a probe.exe', 'if 1==1 paint.exe', 'if 1==1 paint', 'if 1==1 @probe.exe', 'if 1==1 @(probe.exe)', 'if 1==1 if 2==2 probe.exe',
    'if 1==1 (probe.exe)', 'if 1==2 (echo a) else (probe.exe)', 'if 1==2 (echo a) else probe.exe', 'if 1==1 (echo a & probe.exe)',
    'if 1==1 (echo a & echo b) else (probe.exe)', 'if 1==2 (echo a & echo b) else (echo c & probe.exe)', 'if 1==1 cmd /d/c probe.exe',
    'for %i in (1) do probe.exe', 'for %i in (1) do @probe', 'for %i in (1) do paint', 'for %i in (1)do probe.exe', 'for %i in (1) DO probe',
    'for /l %i in (1,1,2) do probe.exe', 'for /d %i in (.) do probe', 'for /r %i in (*) do probe', 'for /r . %i in (*) do probe',
    'for /f %i in (x.txt) do probe', 'for /f "tokens=*" %i in (x.txt) do probe', 'for %i in (1) do (probe.exe)', 'for %i in (1) do (echo a & probe.exe)',
    'for %i in (1) do if 1==1 probe.exe', 'for %i in (1) do cmd /d/c probe.exe',
    'for /f %i in (\'probe.exe\') do echo %i', 'for /f "usebackq" %i in (`probe.exe`) do echo %i', 'for /f %i in (\'probe\') do echo %i',
    'for /f %i in (\'echo a ^& probe.exe\') do echo %i', 'for /f "tokens=*" %i in (\'dir /b ^| probe.exe\') do echo %i',
    'forfiles /c "probe.exe"', 'forfiles /c probe.exe', 'forfiles /c "cmd /c probe.exe"', 'forfiles /m * /c "cmd /d/c probe.exe @file"',
    'forfiles /c:"probe.exe"', 'forfiles /C "paint"', 'forfiles.exe /p . /s /m *.exe /c "cmd /c paint.exe @path"',
    'echo a & if 1==1 git.exe status', 'echo a & for %i in (1) do git.exe status', 'cmd /c "if 1==1 git.exe status"', '(if 1==1 git.exe status)',
    'if 1==1 git.exe status & probe.exe'
  ]) A.ok(UNPROVEN.test(bodies(c) || '') || GUI_RE.test(bodies(c) || ''), 'the program in the body is judged, and refused: ' + c);
  for (const c of [
    'if', 'if x:', 'if 1,1==1,1 probe.exe', 'if 1==1,probe.exe', 'if exist .,probe.exe', 'if 1==1\u0085probe.exe', 'if 1==1᠎probe.exe',
    'if not /i A==b probe.exe', 'for i in range(3):', 'for %i in (1) do,probe.exe', 'for %i in (1) do(probe.exe)', 'for %i in (a(b)) do probe.exe',
    'for %ia in (1) do probe.exe', 'for %i in (1 do probe.exe', 'for /f %i in (\'probe.exe) do echo %i',
    'forfiles /c "cmd /c echo 0x26 probe.exe"', 'forfiles /m * /c"cmd /c probe.exe"', 'forfiles /c', 'forfiles /m * /c cmd /c probe.exe',
    'forfiles /c "cmd /c echo a" /c "cmd /c probe.exe"', 'forfiles /c "cmd /c echo a" /C:"probe.exe"',
    'if 1==1 '.repeat(10) + 'probe.exe'
  ]) A.ok(UNPROVEN.test(bodies(c) || ''), 'a statement whose body the guard cannot place is refused, never read as empty: ' + JSON.stringify(c));
  // the same body behind the text floors
  A.eq((bodiesSafety('if 1==1 shutdown /r /t 0') || {}).kind, 'machine-state', 'shutdown in an if body is a machine-state refusal');
  A.eq((bodiesSafety('for %i in (1) do shutdown /r') || {}).kind, 'machine-state', 'and in a for body');
  A.eq((bodiesSafety('if 1==2 (echo a) else (shutdown /r)') || {}).kind, 'machine-state', 'and in an else branch');
  A.eq((bodiesSafety('forfiles /c "cmd /c shutdown /r"') || {}).kind, 'machine-state', 'and behind forfiles');
  A.eq((bodiesSafety('if exist . start notepad') || {}).kind, 'visible-desktop', 'a window opened from an if body is a visible-desktop refusal');
  // what stays allowed: builtins, and a console program that is the first command typed
  for (const c of [
    'if 1==1 echo hi', 'if exist . echo hi', 'if not exist nosuch echo hi', 'if "a"=="a" (echo hi) else (echo no)', 'if 1==1 echo hi & echo there',
    'if 1==2 (echo a) else (echo b)', 'if /i "%OS%"=="Windows_NT" echo hi', 'if %ERRORLEVEL% neq 0 exit /b 1',
    'if 1==1 git.exe status', 'if exist . git.exe status', 'if 1==2 (echo a) else git.exe status', 'if 1==1 @git.exe status', 'if 1==1 if 2==2 git.exe status',
    'for %i in (1) do echo %i', 'for %i in (1 2) do @echo %i', 'for /l %i in (1,1,3) do echo %i', 'for /f "tokens=*" %i in (\'dir /b\') do echo %i',
    'for /f "usebackq tokens=*" %i in (`dir /b`) do echo %i', 'for /f %i in (\'git.exe status\') do echo %i', 'for %i in (1)do echo %i', 'for %i in (1) do git.exe status',
    'for %i in (1) do (echo %i)', 'for /r %i in (*.txt) do echo %i', 'for /d %i in (*) do @echo %i', 'if /?', 'for /?',
    'forfiles', 'forfiles /p . /m * /c "cmd /c echo @file"', 'forfiles /s /m *.txt /d -30 /c "cmd /c echo @path"', 'forfiles /c:"cmd /c echo @file"'
  ]) A.eq(bodies(c), null, 'control, still runs: ' + JSON.stringify(c));
  // a block spread over lines is one statement, not a head per line: its closing parenthesis and else were heads of their own
  A.eq(bodies('if 1==1 (\n echo a\n) else (\n echo b\n)'), null, 'a multi-line if / else block of builtins runs');
  A.eq(bodies('for %i in (1) do (\n echo a\n echo b\n)'), null, 'a multi-line for block of builtins runs');
  A.ok(UNPROVEN.test(bodies('if 1==1 (\n echo a\n) else (\n probe.exe\n)') || ''), 'and the program in its else branch is still judged');
  A.ok(UNPROVEN.test(bodies('for %i in (1) do (\n echo a\n probe.exe\n)') || ''), 'and so is the one in a multi-line for block');
}
A.eq(wrapFs.openCount(), 0, 'every file read for the body rows was closed');

// ---- PowerShell and sh find a bare name along PATH, and the guard asks the same question (GitHub #167/#163, review round 7) ----
// Read off the real PowerShell 5.1 with harmless programs: a bare command name is never looked for in the working folder, only
// along PATH (a relative PATH entry is read from the working folder), each folder in PATHEXT order with a .ps1 script ahead of them;
// & and . and quotes put no program of their own before the name; the statements inside {...}, (...) and $(...) run; and Start-Process,
// saps, start, Invoke-Item and ii open or launch whatever they are given (a file, a folder, a URL, an app registered under App
// Paths), which a search of PATH cannot bound. The nested program was judged only when it was spelled .exe or .\, so
// `powershell -c winver` ran the real GUI app that `winver` on its own is refused for. A name PATH does not hold is a cmdlet, an
// alias or an error: nothing runs from a file, so it is left alone; a target held in a variable or an expression is refused.
const scriptShim = Buffer.from('@echo off\nnotepad forbidden.txt\n');
const psFs = memFs({
  'C:\\bin\\winver.exe': GUI, 'C:\\bin\\hostname.exe': CONSOLE, 'C:\\bin\\cmd.exe': CONSOLE, 'C:\\bin\\powershell.exe': CONSOLE, 'C:\\bin\\pwsh.exe': CONSOLE,
  'C:\\bin\\sh.exe': CONSOLE, 'C:\\bin\\bash.exe': CONSOLE, 'C:\\bin\\git.exe': CONSOLE, 'C:\\bin\\npm.cmd': Buffer.from('@echo package shim\n'),
  'C:\\bin\\unsafe.cmd': scriptShim, 'C:\\bin\\pick.ps1': Buffer.from('Write-Output hi\n'), 'C:\\bin\\pick.exe': CONSOLE,
  'C:\\bin\\twin.cmd': scriptShim, 'C:\\bin\\twin.exe': CONSOLE, 'C:\\proj\\probe.exe': GUI, 'C:\\later\\alias.exe': CONSOLE
}, { 'c:\\store\\alias.exe': 'EACCES' });
{
  const ps = (c, o) => risk(c, Object.assign({ fs: psFs }, o));
  const psSafety = (c, o) => commandSafetyRisk(c, Object.assign({}, at, { fs: psFs }, o));
  const refusedAs = v => GUI_RE.test(v || '') || UNPROVEN.test(v || '');
  for (const c of [
    'powershell -c winver', 'powershell -c "Write-Output ok; winver"', 'powershell -c "Start-Process winver"', 'powershell -c "& winver"', 'powershell -c "& { winver }"',
    'pwsh -c winver', 'sh -c winver', 'powershell -c "Invoke-Item .\\probe.exe"', 'powershell -c "ii probe.exe"',
    'powershell -NoProfile -c winver', 'powershell.exe -Command winver', 'powershell winver', 'powershell -c "&winver"', 'powershell -c "& \'winver\'"', 'powershell -c ". winver"',
    'powershell -c "winver | Out-Null"', 'powershell -c "Get-Date; winver"', 'powershell -c "winver; Write-Output ok"', 'powershell -c "if ($true) { winver }"',
    'powershell -c "if($true){winver}"', 'powershell -c "foreach ($i in 1) { winver }"', 'powershell -c "1 | ForEach-Object { winver }"',
    'powershell -c "Write-Output (winver)"', 'powershell -c "Start-Process -FilePath winver"', 'powershell -c "saps winver"', 'powershell -c "start winver"',
    'powershell -c "Start-Process -NoNewWindow hostname"', 'powershell -c "Start-Process https://example.com"', 'powershell -c "Invoke-Item ."', 'powershell -c "ii ."',
    'powershell -c "Start-Job { winver }"', 'powershell -c "icm { winver }"', 'powershell -c "& { Write-Output ok; winver }"', 'powershell -c "& { & winver }"',
    'powershell -c "cmd /c winver"', 'powershell -c "powershell -c winver"', 'powershell -c "pwsh -c winver"', 'powershell -c "sh -c winver"',
    'powershell -c "$x=1; & { if ($x) { winver } }"',
    'sh -c "echo a; winver"', 'bash -c winver', 'bash -lc winver', 'sh -ec winver', 'bash --noprofile -c winver', 'sh -c "winver &"',
    'powershell -c "sub\\tool"', 'powershell -c "sub/tool"', 'powershell -c "C:\\Windows\\System32\\winver"',
    'powershell -c unsafe', 'powershell -c pick', 'powershell -c "Get-Date; unsafe"', 'powershell -c "& winv\'er\'"', 'powershell -c "&\'winver\'"'
  ]) A.ok(refusedAs(ps(c)), 'the program PowerShell or sh would run is judged, and refused: ' + c);
  for (const c of [
    'powershell -c "$x=\'winver\'; & $x"', 'powershell -c "& (Get-Command winver)"', 'powershell -c "& (\'win\'+\'ver\')"', 'powershell -c "& $env:windir\\system32\\winver.exe"',
    'powershell -c ". $x"', 'powershell -c "& $args[0]"'
  ]) A.ok(UNPROVEN.test(ps(c) || ''), 'a target held in a variable or an expression cannot be placed, so it is refused: ' + c);
  // typed straight into PowerShell (no cmd quoting in the way), an interpolated string is an expression too
  for (const c of ['& "$env:windir\\system32\\winver.exe"', '& "win$x"', '. "$x"', '$h = \'winver\'; & $h']) {
    A.ok(UNPROVEN.test(ps(c, { dialect: 'powershell' }) || ''), 'in PowerShell itself, a target built at run time is refused: ' + c);
  }
  for (const c of ['"winver"', "'winver'", '$h = \'winver\'; $h', '& \'hostname\'', 'hostname']) {
    A.eq(ps(c, { dialect: 'powershell' }), null, 'in PowerShell itself, control: ' + c);
  }
  A.ok(refusedAs(ps('winver', { dialect: 'powershell' })), 'in PowerShell itself, a bare name is looked up along PATH too');
  A.ok(refusedAs(ps('& winver', { dialect: 'powershell' })), 'and behind the call operator');
  A.eq(ps('probe', { dialect: 'powershell' }), null, 'and the working folder is not on that path');
  A.ok(refusedAs(ps('powershell -c alias', { env: { PATH: 'C:\\store;C:\\later' } })), 'a store alias first on PATH (EACCES) is not skipped so a later copy can vouch');
  A.ok(refusedAs(ps('powershell -c winver', { env: { PATH: '\\\\192.0.2.1\\tools;C:\\bin' } })), 'a network PATH entry is not walked');
  A.ok(!psFs.touched.some(f => /192\.0\.2\.1/.test(f)), 'and nothing reaches the network for it');
  A.ok(refusedAs(ps('powershell -c probe', { env: { PATH: 'C:\\bin;.' } })), 'a relative PATH entry is read from the folder the command runs in, where probe.exe is');
  A.ok(refusedAs(ps('powershell -c twin', { env: { PATH: 'C:\\bin', PATHEXT: '.CMD;.EXE' } })), 'PATHEXT order picks the batch file, whose source is scanned');
  // the text floors read the same statements
  A.eq((psSafety('powershell -c "& { shutdown /r /t 0 }"') || {}).kind, 'machine-state', 'shutdown in a script block is a machine-state refusal');
  A.eq((psSafety('powershell -c "Start-Job { Stop-Computer }"') || {}).kind, 'machine-state', 'and behind Start-Job');
  A.eq((psSafety('powershell -c "icm { shutdown /r }"') || {}).kind, 'machine-state', 'and behind icm');
  A.eq((psSafety('powershell -c "if ($true) { Restart-Computer }"') || {}).kind, 'machine-state', 'and in an if block');
  A.eq((psSafety('powershell -c "& { start notepad }"') || {}).kind, 'visible-desktop', 'a window opened from a script block is a visible-desktop refusal');
  // the other ways PowerShell reaches a launcher (.NET, COM, WMI) are as refused as Start-Process
  for (const c of ['powershell -c "[Diagnostics.Process]::Start(\'winver\')"', 'powershell -c "[System.Diagnostics.Process]::Start(\'winver\')"',
    'powershell -c "(New-Object -ComObject WScript.Shell).Run(\'winver\')"', 'powershell -c "(New-Object -ComObject Shell.Application).Open(\'winver\')"',
    'powershell -c "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=\'winver\'}"',
    'powershell -c "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList winver"']) {
    A.ok(psSafety(c), 'a launcher PowerShell reaches another way is refused: ' + c);
  }
  // what stays allowed: cmdlets, console programs by bare name wherever they stand, and names PATH does not hold
  for (const c of [
    'powershell -c hostname', 'powershell -c "Write-Output ok"', 'powershell -c Get-ChildItem', 'powershell -c "Get-ChildItem | Sort-Object Name"',
    'powershell -c "Get-Process | Where-Object { $_.CPU -gt 1 } | Select-Object -First 3"', 'powershell -c "Get-ChildItem | % { $_.Name }"',
    'powershell -c "Get-ChildItem | ? { $_.Length -gt 1 }"', 'powershell -c "$x = 1; Write-Output $x"', 'powershell -c "if ($true) { Write-Output ok } else { Write-Output no }"',
    'powershell -c "foreach ($i in 1..3) { Write-Output $i }"', 'powershell -c "Write-Output (Get-Date)"', 'powershell -c "(Get-Date).Year"',
    'powershell -c "Set-Location sub; Get-ChildItem"', 'powershell -c "git status"', 'powershell -c "Get-Date; hostname"', 'powershell -c "hostname; Get-Date"',
    'powershell -c npm', 'powershell -c "cmd /c echo ok"', 'powershell -c "Write-Output winver"', 'powershell -c "echo winver"', 'powershell -c "Get-Content probe.exe"',
    'powershell -c "Write-Output \'Start-Process winver\'"', 'powershell -c "& hostname"', 'powershell -c "& { hostname }"', 'powershell -c "Start-Sleep 1"',
    'powershell -c probe', 'powershell -c "& \'win\'+\'ver\'"', 'powershell -c "win*"', 'powershell -c "\'winver\'"', 'sh -c hostname', 'sh -c "echo a; hostname"', 'bash -lc hostname', 'sh -c "git status"',
    'powershell -File a.ps1'
  ]) A.eq(ps(c), null, 'control, still runs: ' + c);
  A.eq(ps('powershell -c twin', { env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' } }), null, 'control: PATHEXT order picks the console program, and it runs');
}
A.eq(psFs.openCount(), 0, 'every file read for the PowerShell rows was closed');

// ---- PowerShell's short option names are read, and an option it cannot name is refused unread ----
const safety = (c, o) => commandSafetyRisk(c, Object.assign({}, at, o));
for (const c of [
  'powershell -ep Bypass -c Stop-Computer',
  'powershell -ep Bypass -c "Set-ExecutionPolicy Unrestricted -Scope CurrentUser"',
  'pwsh -wd sub -c Stop-Computer',
  'powershell -NoSuchOption Stop-Computer',
  'pwsh -custompipename x -c Stop-Computer',
  // Windows PowerShell does not know these and runs the "value" as command text
  'powershell -nop -settingsfile "x; Stop-Computer"',
  'powershell -nop -custompipename "x; Stop-Computer"',
  'powershell -nop -psconsolefile "x; Stop-Computer"',
  // each short name reads past the right number of tokens
  'powershell -w hidden -c Stop-Computer',
  'powershell -if Text -c Stop-Computer',
  'powershell -of Text -c Stop-Computer',
  'powershell -o Text -c Stop-Computer',
  'powershell -i Text -c Stop-Computer',
  'pwsh -l Stop-Computer',
  'pwsh -login Stop-Computer',
  'pwsh -interactive Stop-Computer',
  'pwsh --version Stop-Computer'
]) A.ok(safety(c), 'read and refused: ' + c);
for (const c of ['pwsh --version', 'pwsh --help', 'powershell --version', 'powershell -o Text -c Get-Date', 'powershell -i Text -c Get-Date', 'powershell -w hidden -c Get-Date', 'powershell -psconsolefile a.psc1 -c Get-Date']) {
  A.eq(safety(c), null, 'still runs: ' + c);
}
A.eq(safety('constructor'), null, 'a word is not an option');
A.ok(safety('powershell -constructor Stop-Computer'), 'an option named like an object key is still unknown');

// ---- each character that cancels the policy exception, alone, with a control ----
const inPowerShell = c => commandSafetyRisk(c, Object.assign({}, at, { dialect: 'powershell' }));
const policyHead = 'Set-ExecutionPolicy -Scope Process Bypass; ';
A.eq(inPowerShell(policyHead + 'echo a'), null, 'the plain shape runs');
A.ok(safety('powershell -c Set-ExecutionPolicy -Scope Process Bypass "; Stop-Computer"'), 'the argv join cannot earn the exception');
A.ok(safety('powershell -c Set-ExecutionPolicy -Scope Process Bypass "; Set-ExecutionPolicy Unrestricted -Scope CurrentUser"'), 'nor can a second mention');
for (const ch of ['`', '+', '$', '(', ')', '{', '}', '*', '?', '[', ']']) A.ok(inPowerShell(policyHead + 'echo a' + ch), 'cancels the exception alone: ' + ch);
for (const word of ['iex y', 'Invoke-Expression y', 'Invoke-Command y']) A.ok(inPowerShell(policyHead + word), 'cancels the exception alone: ' + word);
A.ok(risk('powershell -ep Bypass -c paint.exe'), 'a program behind -ep is refused');
A.ok(risk('pwsh -wd sub -c .\\helper.exe'), 'a program behind -wd is read');

// ---- which copy answers ----
A.ok(GUI_RE.test(risk('pair.exe') || ''), 'a console copy in the working folder does not stop PATH\'s GUI copy being read');
A.eq(risk('one.exe', { env: { PATH: 'C:\\bin;C:\\later' } }), null, 'PATH stops at its first copy, as Windows does');
A.ok(GUI_RE.test(risk('C:shadow.exe') || ''), 'a drive-relative head is read as its own file');
A.ok(UNPROVEN.test(risk('tools\\folder.exe') || ''), 'a folder named .exe is not a program');
A.ok(UNPROVEN.test(risk('git.exe status', { exactCwd: 1 }) || ''), 'exactCwd means exactly true');
A.eq(risk('tools\\zed.exe'), null, 'a file past the default PATHEXT is no shadow');
A.ok(UNPROVEN.test(risk('tools\\zed.exe', { env: { PATH: env.PATH, PATHEXT: '.ZZZ' } }) || ''), 'the machine\'s own PATHEXT is the one read');
A.eq(risk('git.exe status', { env: { PATH: 'C:\\afile;C:\\bin' } }), null, 'a PATH entry that is a file (ENOTDIR) is just absent');
A.eq(risk('tools/venv/Scripts/python.exe --version', { dialect: 'powershell' }), null, 'PowerShell reads / as a path');
A.ok(UNPROVEN.test(risk('powershell -c "tools/venv/Scripts/python.exe --version"') || ''), 'a nested program is refused whatever its dialect');
A.ok(UNPROVEN.test(risk("'C:\\Program Files\\gone\\x.exe' --v", { dialect: 'powershell' }) || ''), 'a single-quoted path with spaces is judged too');

// ---- nesting stays cheap, and too deep is refused rather than unread ----
const deep = memFs({ 'C:\\bin\\git.exe': CONSOLE, 'C:\\bin\\cmd.exe': CONSOLE, 'C:\\bin\\paint.exe': GUI });
A.ok(risk('cmd.exe /c cmd.exe /c paint.exe', { fs: deep }), 'a GUI program under console wrappers is refused');
A.ok(UNPROVEN.test(risk('cmd.exe /c '.repeat(6) + 'git.exe status', { fs: deep }) || ''), 'console wrappers do not vouch for a console program');
A.eq(risk('git.exe status', { fs: deep }), null, 'the same program typed directly runs');
A.ok(GUI_RE.test(risk('paint.exe', { fs: deep }) || ''), 'a GUI program typed directly is named as one');
const statsSix = deep.touched.length;
A.ok(risk('cmd.exe /c '.repeat(12) + 'paint.exe', { fs: deep }), 'nesting past what is read is refused');
A.ok(statsSix < 2000, 'six wrappers stay cheap: ' + statsSix + ' stats');
const before = deep.touched.length;
A.ok(risk('cmd.exe /c '.repeat(40) + 'git.exe status', { fs: deep }), 'forty wrappers are refused');
A.ok(deep.touched.length - before < 2000, 'forty wrappers stay cheap: ' + (deep.touched.length - before) + ' stats');

// ---- every caller says whether it knows the folder: only the ones that do ----
const source = f => fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', f), 'utf8');
const shellSource = source('shell.js');
A.ok(/commandSafetyRisk\(cmd, \{ cwd: hostCwd, exactCwd: true,/.test(shellSource), 'shell.exec knows its folder');
A.ok(/commandSafetyRisk\(input, \{ cwd: jailRoot, fs: fs,/.test(shellSource), 'shell.bg.write types into a live shell and claims nothing');
A.ok(/commandSafetyRisk\(cmd, \{ cwd: hostCwd, exactCwd: true,/.test(source('verify.js')), 'verify.run knows its folder');
const terminalSource = source('terminal.js');
A.ok(/safety\(command, where\.cwd, ctx \|\| \{\}, true\)/.test(terminalSource), 'terminal.start knows its folder');
A.ok(/safety\(data, s\.cwd, ctx \|\| \{\}\)/.test(terminalSource), 'text typed into a terminal claims nothing');
A.ok(/exactCwd: exactCwd === true/.test(terminalSource), 'and terminal.js passes on what it was told');

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
  'powershell -c "Set-ExecutionPolicy -Scope Process Bypass;" "Set-ExecutionPolicy Unrestricted -Scope CurrentUser"',
  'powershell -c "Set-ExecutionPolicy -Scope Process Bypass;" "Set-Exec`utionPolicy Unrestricted -Scope CurrentUser"',
  'Set-Exec`utionPolicy -Scope Process Bypass',
  'Set-ExecutionPolicy -Scope Process Bypass; iex "x"',
  "Set-ExecutionPolicy -Scope Process Bypass; & ('Set-Execution'+'Policy') Unrestricted",
  'Set-ExecutionPolicy -Scope Process Bypass; Invoke-Expression y',
  'powershell -c "Set-ExecutionPolicy -Scope Process Bypass; & (gcm Set-Exec*Policy) Unrestricted -Scope CurrentUser"',
  "Set-ExecutionPolicy -Scope Process Bypass; & (('Set-Execution','Policy') -join '') Unrestricted",
  'Set-ExecutionPolicy -Scope Process Bypass; Stop-Computer'
]) A.ok(policy(c) && policy(c).kind === 'machine-state', '#163 still refused: ' + c);

// ---- real programs, where this machine has them ----
if (process.platform === 'win32') {
  const real = { cwd: process.cwd(), exactCwd: true, fs, pathMod: path, dialect: 'cmd' };
  A.eq(inputIsolationRisk('"' + process.execPath + '" --version', real), null, 'the real node.exe is a console program');
  const charmap = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'charmap.exe');
  if (fs.existsSync(charmap)) A.ok(GUI_RE.test(inputIsolationRisk('"' + charmap + '"', real) || ''), 'the real charmap.exe is a GUI program');
  // the real System32 GUI programs behind every spelling of cmd's switch: the decision only, nothing here starts them
  for (const c of ['cmd /d/c winver', 'cmd /r winver', 'cmd /cwinver', 'cmd /c"winver.exe"', 'cmd /d/c charmap', 'cmd /rcharmap.exe', 'cmd /q/s/c winver']) {
    A.ok(UNPROVEN.test(inputIsolationRisk(c, real) || ''), 'the real GUI program behind cmd is refused, however the switch is spelled: ' + c);
  }
  A.eq(inputIsolationRisk('cmd /d/c echo ok', real), null, 'control: the real cmd with a builtin body still runs');
  // and behind if, for and forfiles: a real GUI program as the body is refused as one (typed first) or as unproven (grouped, nested)
  for (const c of ['if 1==1 winver', 'if exist . winver', 'for %i in (1) do winver', 'for %i in (1) do @charmap.exe', 'if 1==1 (winver)',
    'forfiles /c "cmd /c winver"', 'for /f %i in (\'winver\') do echo %i', 'if 1==2 (echo a) else winver']) {
    const verdict = inputIsolationRisk(c, real) || '';
    A.ok(GUI_RE.test(verdict) || UNPROVEN.test(verdict), 'the real GUI program in a builtin\'s body is refused: ' + c);
  }
  A.eq(inputIsolationRisk('if 1==1 hostname', real), null, 'control: a real console program typed first in an if body still runs');
  // and behind PowerShell and sh: a bare name is looked up along the real PATH, where winver and charmap live
  for (const c of ['powershell -c winver', 'powershell -c "Write-Output ok; winver"', 'powershell -c "Start-Process winver"', 'powershell -c "& winver"', 'powershell -c "& { winver }"',
    'pwsh -c winver', 'sh -c winver', 'powershell -c charmap', 'powershell -c "Invoke-Item ."', 'powershell -c "ii winver.exe"', 'powershell -c "1 | ForEach-Object { charmap }"']) {
    const verdict = inputIsolationRisk(c, real) || '';
    A.ok(GUI_RE.test(verdict) || UNPROVEN.test(verdict), 'the real GUI program behind PowerShell or sh is refused: ' + c);
  }
  for (const c of ['powershell -c hostname', 'powershell -c "Write-Output ok"', 'powershell -c Get-ChildItem', 'powershell -c "Get-Date; hostname"']) {
    A.eq(inputIsolationRisk(c, real), null, 'control: still runs behind the real PowerShell: ' + c);
  }
}
A.report('shell-local-program.test');
