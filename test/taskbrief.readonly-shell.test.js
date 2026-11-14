/* node test/taskbrief.readonly-shell.test.js — A LOOK WITH THE SHELL IS NOT THE WORK (cost audit W3.12, 2026-11-14).

   THE COST: the Task Brief gate holds every shell.exec call (scope 'execute') until brief_proceed, so `ls`, `rg x` and
   `git status` were held like a write. A model that looks around with the shell first paid a whole request for the held
   call. Behind STARNET_BRIEF_READONLY_SHELL (off by default) a shell.exec call that certainly only looks is not held.

   THIS FILE pins the two pure halves and the wiring:
     A. sidecar/readonly-shell.js readOnlyCommand: the table. An ALLOWLIST: every command in LOOKS passes, every command
        in HELD is held, and so is every generated variant that adds a shell metacharacter, a non-ASCII character or a
        flag that is not on the program's list to a command that passes.
     B. readOnlyCall: the call's other arguments (a cwd, background:true, anything undeclared) hold it.
     C. taskbrief-policy.js looksOnly: only shell.exec, only while the brief is open; canMutate itself is unchanged, so
        with the switch off the gate holds every one of these exactly as before.
     D. index.js: the switch is read once, through ENV(), off by default, and consulted at one place (briefHoldFor).
     E. the other protections do not read this file: a command that passes here and leaves the workspace is still
        refused by the shell's own floor.
     F. this machine's real shell hands the program exactly the flags the classifier vetted, for every passing line.
   The e2e proof (request counts off and on, approval cards, refusals) is test/brief-readonly-shell.e2e.test.js.
   RED on 57c741da7: sidecar/readonly-shell.js does not exist there. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const RO = require('../sidecar/readonly-shell.js');
const Policy = require('../sidecar/taskbrief-policy.js');

const looks = cmd => RO.readOnlyCommand(cmd).ok === true;
const show = cmd => JSON.stringify(cmd) + ' -> ' + JSON.stringify(RO.readOnlyCommand(cmd));

/* ---- A. THE TABLE ------------------------------------------------------------------------------------------------- */
const LOOKS = [
  'ls', 'ls -la', 'ls -1', 'ls -lah src/app', 'ls --color=never -R docs', '  ls -la  ',
  'dir', 'dir /s /b', 'dir sidecar\\tools',
  'pwd',
  'cat README.md', 'cat -n package.json', 'cat docs/BRAIN.md docs/NEXT.md', 'cat "my notes.txt"',
  'type README.md', 'type sidecar\\index.js',
  'head -n 40 sidecar/loop.js', 'head -20 README.md', 'head -n5 notes.txt',
  'tail -n 100 logs/run.log', 'tail -n +5 file.txt',
  'wc -l sidecar/index.js',
  'rg --files', 'rg -n TODO', 'rg -n "brief gate" sidecar', 'rg -il canMutate sidecar test', 'rg -e needle -g index.js -C 2 .',
  'rg --hidden --no-ignore -F "a.b" src', 'rg -t js -m 5 needle -- src', 'rg \'needle\' src', 'rg -n \'two words\' src',
  'rg "x --pre=evil"',   // ONE quoted word in both shells: a pattern to search for, never a flag
  'grep -rn TODO src', 'grep -n -i "task brief" README.md', 'grep -c --include=index.js -r needle .',
  'findstr /s /n /i needle index.js',
  'find . -maxdepth 2 -type f', 'find src -name package.json -print', 'find . -type d -mtime -7',
  'git status', 'git status --short --branch', 'git status --porcelain=v1 --untracked-files=no',
  'git --no-pager log --oneline -n 5', 'git log -5 --stat', 'git log --since=2.weeks --author=andro --format=oneline',
  'git diff', 'git diff --stat HEAD~1', 'git diff --cached -- sidecar/index.js',
  'git show HEAD:README.md', 'git show --stat --oneline HEAD',
  'git branch', 'git branch --list', 'git branch -a -v', 'git branch --show-current',
  'git rev-parse HEAD', 'git rev-parse --abbrev-ref HEAD', 'git rev-parse --show-toplevel',
  'where git', 'which -a node',
  'ls -o', 'rg -o needle src', 'grep -c needle README.md',   // -o and -c here print (long listing, only the match, a count): they write nothing
  'echo hello', 'echo "all done here"'
];

// [command, what it is]. Every one must be HELD: the adversarial half of the table, plus plain commands that are not
// certainly a look (the gate holds them exactly as before).
const HELD = [
  // -- a second command, a pipe, a redirect
  ['ls | tee out.txt', 'a pipe to tee'],
  ['git status; rm -rf x', 'a second command after ;'],
  ['rg x -o > f', 'a redirect'],
  ['ls && rm -rf x', '&&'],
  ['ls || rm x', '||'],
  ['ls & del x', 'cmd.exe &'],
  ['ls > out.txt', '>'],
  ['ls >> out.txt', '>>'],
  ['cat < in.txt', '<'],
  ['cat <<EOF', 'a here-doc'],
  ['echo hi > note.txt', 'echo into a file'],
  ['ls -la 2>&1', 'a stderr redirect'],
  ['(ls)', 'a subshell'],
  ['ls ^& del x', 'a cmd.exe caret escape'],
  // -- substitution, variables, expansion
  ['cat $(echo /etc/passwd)', '$( )'],
  ['ls $(pwd)', '$( )'],
  ['echo `id`', 'backticks'],
  ['echo $HOME', 'a sh variable'],
  ['ls ${HOME}', 'a sh variable in braces'],
  ['echo %USERPROFILE%', 'a cmd.exe variable'],
  ['echo !x!', 'cmd.exe delayed expansion'],
  ['ls ~', 'home expansion'],
  ['cat ~/.ssh/id_rsa', 'home expansion'],
  ['ls *', 'a glob (may expand to options)'],
  ['ls *.md', 'a glob'],
  ['cat ?.txt', 'a glob'],
  ['ls [a-z]x', 'a glob class'],
  ['ls {a,b}', 'brace expansion'],
  ['ls # comment', 'a comment'],
  // -- separators that are not a space, and look-alikes
  ['ls\nrm -rf x', 'a newline'],
  ['ls\r\nrm x', 'CRLF'],
  ['ls\trm', 'a tab'],
  ['ls \uFF1B rm -rf x', 'a fullwidth semicolon'],
  ['ls \u037E rm x', 'a Greek question mark (looks like ;)'],
  ['ls \uFF5C tee x', 'a fullwidth pipe'],
  ['ls\u00A0-la', 'a no-break space'],
  ['git status\u2028rm -rf x', 'a Unicode line separator'],
  ['ls\u200B', 'a zero-width space'],
  ['ls \u2212la', 'a Unicode minus'],
  ['\u217Cs', 'a look-alike letter'],
  // -- an environment prefix or a wrapper
  ['FOO=1 ls', 'an env assignment'],
  ['GIT_PAGER=cat git log', 'an env assignment'],
  ['env FOO=1 ls', 'env'],
  ['set X=1 && dir', 'set'],
  ['sh -c ls', 'a shell'],
  ['bash -lc ls', 'a shell'],
  ['cmd /c dir', 'a shell'],
  ['xargs ls', 'xargs'],
  ['powershell -NoProfile -Command "gc x | sc y"', 'PowerShell writing through aliases'],
  ['gc x | sc y', 'PowerShell aliases that write'],
  ['powershell -Command "ls"', 'PowerShell'],
  ['node -e "require(\'fs\').rmSync(\'x\')"', 'an interpreter'],
  ['python -c "print(1)"', 'an interpreter'],
  // -- quoting and escapes that the two shells read differently
  ['cat a\\ b', 'an escaped space'],
  ['cat "a\\"b"', 'an escaped quote'],
  ['ls \\\\server\\share', 'a UNC path (a leading backslash)'],
  ['ls "a" "b', 'an open quote'],
  ['ls "a"b', 'a quote glued to a word'],
  ['ls a"b c"', 'a quote inside a word'],
  ['ls \'-la\'', 'a quoted flag'],
  ['rg \'x --pre=evil\'', 'a flag cmd.exe would see inside single quotes'],
  ['"ls" -la', 'a quoted program'],
  // -- flags that write, run a program, follow forever, or are simply not on the list
  ['git -c core.pager=less status', 'git -c'],
  ['git -c core.fsmonitor=evil status', 'git -c'],
  ['git -C other status', 'git -C'],
  ['git --exec-path=x status', 'git --exec-path'],
  ['git status --upload-pack=evil', 'an unknown git flag'],
  ['git log --output=out.txt', 'git --output'],
  ['git diff --output out.patch', 'git --output'],
  ['git diff --ext-diff', 'git --ext-diff'],
  ['git show --ext-diff HEAD', 'git --ext-diff'],
  ['git log -p --textconv', 'git --textconv'],
  ['git log --format=%H', 'a percent sign'],
  ['git rev-parse --git-path hooks', 'an unlisted rev-parse flag'],
  ['git status -uno', 'an unlisted short flag'],
  ['git status -o f', 'git has no -o on the list'], ['git log -o out.txt', 'git has no -o on the list'], ['git diff -o x', 'git has no -o on the list'],
  ['git status -c x=y', 'a -c after the subcommand is not on the list either'], ['git log -c core.pager=evil', 'an unlisted short flag'],
  ['rg --pre cat needle', 'rg --pre runs a program'],
  ['rg --pre=cat needle', 'rg --pre runs a program'],
  ['rg -z needle', 'rg -z runs decompressors'],
  ['rg --search-zip needle', 'rg --search-zip'],
  ['rg --hostname-bin=evil needle', 'rg --hostname-bin runs a program'],
  ['rg needle -r repl', 'rg -r'],
  ['rg -e -pre', 'a value that starts with -'],
  ['find . -delete', 'find -delete'],
  ['find . -name x -delete', 'find -delete'],
  ['find . -exec rm x +', 'find -exec'],
  ['find . -execdir sh x', 'find -execdir'],
  ['find . -ok rm x', 'find -ok'],
  ['find . -fprint out.txt', 'find -fprint'],
  ['tail -f app.log', 'tail -f never ends'],
  ['tail --follow app.log', 'tail --follow'],
  ['head -n -5 file', 'a value that starts with -'],
  ['wc -l --files0-from=list', 'an unlisted flag'],
  ['grep -f patterns.txt x', 'an unlisted flag'],
  ['ls --dired', 'an unlisted flag'],
  ['cat', 'standard input'],
  ['cat -', 'standard input'],
  ['pwd extra', 'an operand pwd does not take'],
  // -- git that is not a look
  ['git branch newbranch', 'creates a branch'],
  ['git branch -D main', 'deletes a branch'],
  ['git branch -m old new', 'renames a branch'],
  ['git branch --list -d x', 'deletes a branch'],
  ['git checkout main', 'checkout'],
  ['git stash', 'stash'],
  ['git fetch', 'the network'],
  ['git config --get user.name', 'an unlisted subcommand'],
  ['git', 'no subcommand'],
  // -- programs that are not on the list
  ['rm -rf x', 'rm'], ['sed -n 1p file', 'sed'], ['sed -i s/a/b/ file', 'sed -i'], ['tee out.txt', 'tee'], ['cp a b', 'cp'], ['mv a b', 'mv'],
  ['touch x', 'touch'], ['mkdir x', 'mkdir'], ['curl http://example.com', 'curl'], ['wget example.com', 'wget'], ['more file', 'more'],
  ['less file', 'less'], ['tree', 'tree'], ['stat x', 'stat'], ['du -sh', 'du'], ['printenv', 'printenv'], ['set', 'set'], ['env', 'env'],
  ['npm test', 'npm'], ['node build.js', 'node'],
  // -- the program is not named bare and in lower case
  ['LS', 'upper case'], ['Git status', 'mixed case'], ['./ls', 'a path'], ['ls.exe', 'an extension'], ['C:\\tools\\ls.exe', 'a path'],
  ['dir/s', 'a switch glued to the program'], ['echo.', 'echo.'],
  // -- not a command at all
  ['', 'empty'], ['   ', 'only spaces'], ['ls ' + 'a'.repeat(400), 'too long'], ['ls ' + new Array(45).fill('a').join(' '), 'too many words']
];

for (const cmd of LOOKS) A.ok(looks(cmd), 'A: a look passes: ' + show(cmd));
for (const [cmd, what] of HELD) A.ok(!looks(cmd), 'A: held (' + what + '): ' + show(cmd));
A.ok(LOOKS.length + HELD.length >= 60 && HELD.length >= LOOKS.length, 'A: the table has at least 60 commands and at least half are held ones: ' + LOOKS.length + ' looks, ' + HELD.length + ' held');
for (const v of [null, undefined, 7, true, ['ls'], { cmd: 'ls' }]) A.eq(RO.readOnlyCommand(v).ok, false, 'A: a command that is not a string is held: ' + JSON.stringify(v));
// what a passing command can contain at all: plain ASCII, none of the characters a shell acts on
for (const cmd of LOOKS) A.ok(/^[\x20-\x7E]+$/.test(cmd) && !/[|&;<>()$`%^!*?\[\]{}#,@]/.test(cmd), 'A: a passing command holds no shell metacharacter: ' + JSON.stringify(cmd));

// GENERATED: every passing command, with one hostile piece added, is held. Appended, prepended, and put after the program.
{
  const TAILS = [' ; rm -rf x', '; rm -rf x', ' | tee f', '|tee f', ' > f', ' >> f', ' < f', ' && rm x', ' || rm x', ' & del x', ' $(rm x)', ' `rm x`', ' ${X}', ' %X%', ' !X!',
    ' ^& del x', '\nrm x', '\r\nrm x', '\trm x', ' \u2028rm x', ' \uFF1B rm x', ' \uFF5C tee f', ' # x', ' *', ' ~', ' ~/x', ' 2>&1', ' "open', ' \'open', ' a\\ b', ' \\x', ' {a,b}', ' [x]', ' ?',
    ' -', ' --output=f', ' --output f', ' --exec=x', ' -exec rm x +', ' -delete', ' --pre=x', ' --upload-pack=x', ' \'--output=f\'', ' "--output=f"', ' \'a --output=f\''];
  const HEADS = ['FOO=1 ', 'env ', 'sudo ', 'cmd /c ', 'sh -c ', 'time ', '@', '.\\', './', 'x; ', 'x && ', 'x | ', '$(x) ', '"', '\''];
  let n = 0, leaks = [];
  for (const base of LOOKS) {
    const trimmed = base.trim();
    // echo prints its own words, so a plain flag-shaped word after it is still only printed: the flag pieces are for the rest
    const flagTail = t => /^ (-|--|'-|"-|'a --)/.test(t);
    for (const t of TAILS) {
      if (/^echo( |$)/.test(trimmed) && flagTail(t)) continue;
      n++; if (looks(trimmed + t)) leaks.push(trimmed + t);
    }
    for (const h of HEADS) { n++; if (looks(h + trimmed)) leaks.push(h + trimmed); }
  }
  A.eq(leaks.slice(0, 5), [], 'A: no generated hostile variant of a passing command passes (' + n + ' variants)');
  A.ok(n > 3000, 'A: the generated sweep ran (' + n + ' variants)');
}
// every single character outside the safe set holds the line, wherever it sits (all of ASCII, and a spread of Unicode)
{
  const SAFE = /^[A-Za-z0-9 _.\/:=+\\~"'-]$/;
  const chars = [];
  for (let i = 0; i < 128; i++) chars.push(String.fromCharCode(i));
  for (const cp of [0x85, 0xA0, 0xAD, 0x37E, 0x1680, 0x2000, 0x2003, 0x200B, 0x200E, 0x2028, 0x2029, 0x202E, 0x2044, 0x2212, 0x2215, 0x2223, 0x3000, 0xFE54, 0xFF06, 0xFF1B, 0xFF1C, 0xFF1E, 0xFF5C, 0xFEFF, 0x1F600]) chars.push(String.fromCodePoint(cp));
  const leaks = [];
  for (const ch of chars) {
    if (SAFE.test(ch)) continue;
    for (const cmd of ['ls' + ch + 'x', 'ls ' + ch + ' x', 'ls x' + ch, ch + 'ls', 'git status ' + ch, 'echo a' + ch + 'b', 'rg "a' + ch + 'b" src']) if (looks(cmd)) leaks.push(JSON.stringify(cmd));
  }
  A.eq(leaks, [], 'A: a character outside the safe set holds the command wherever it sits');
}
// the lists themselves: no program that writes, runs another program or reaches the network is on them
A.eq(RO.COMMANDS.slice().sort(), ['cat', 'dir', 'echo', 'find', 'findstr', 'git', 'grep', 'head', 'ls', 'pwd', 'rg', 'tail', 'type', 'wc', 'where', 'which'], 'A: the programs on the list, exactly');
A.eq(RO.GIT_SUBCOMMANDS.slice().sort(), ['branch', 'diff', 'log', 'rev-parse', 'show', 'status'], 'A: the git subcommands on the list, exactly');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'readonly-shell.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const never of ['\'pre\'', 'pre-glob', 'search-zip', 'hostname-bin', '\'output\'', 'ext-diff\'', '\'textconv\'', '\'-exec\'', '-execdir', '\'-delete\'', '-fprint', '\'-ok\'', 'upload-pack', 'receive-pack', 'exec-path', '\'retry\'', '\'replace\'', 'files0-from'])
    A.ok(code.indexOf(never) < 0 || (never === 'ext-diff\'' && code.split('ext-diff\'').length === code.split('\'no-ext-diff\'').length), 'A: the lists never name ' + never);
  A.ok(!/require\(|process\.|Date\.|Math\.random/.test(code), 'A: the classifier is pure (no require, no process, no clock, no randomness)');
}

/* ---- B. THE CALL ---------------------------------------------------------------------------------------------------- */
A.eq([{ cmd: 'ls' }, { cmd: 'git status', timeoutMs: 5000 }, { cmd: 'ls', timeout_ms: 1000 }, { cmd: 'ls', background: false }, { cmd: 'ls', cwd: null }, { cmd: 'ls', timeoutMs: undefined }].map(RO.readOnlyCall),
  [true, true, true, true, true, true], 'B: a look with a timeout (or the tool\'s defaults spelled out) passes');
A.eq([{ cmd: 'ls', background: true }, { cmd: 'ls', background: 'true' }, { cmd: 'ls', background: 1 }, { cmd: 'ls', cwd: 'sub' }, { cmd: 'ls', cwd: '.' }, { cmd: 'ls', cwd: '' }, { cmd: 'ls', cwd: 'C:\\' },
  { cmd: 'ls', command: 'rm -rf x' }, { cmd: 'ls', env: { A: '1' } }, { cmd: 'ls', stdin: 'x' }, { cmd: 'ls', timeoutMs: '5' }, { cmd: 'ls', timeoutMs: Infinity }, { cmd: ['ls'] }, { cmd: { toString: () => 'ls' } },
  { command: 'ls' }, { cmd: 'rm x' }, {}, null, undefined, 'ls', ['ls'], 7].map(RO.readOnlyCall),
  new Array(22).fill(false), 'B: a cwd, a background process, an undeclared argument, a command that is not a string, or no call at all is held');
{
  const hostile = { get cmd() { throw new Error('boom'); } };
  A.eq(RO.readOnlyCall(hostile), false, 'B: arguments that throw are held, never thrown');
}

/* ---- C. THE POLICY RULE --------------------------------------------------------------------------------------------- */
const { makeRegistry } = require('../sidecar/tools/registry.js');
const Shell = require('../sidecar/tools/builtin/shell.js');
const reg = makeRegistry();
const made = Shell.makeShellTool({ environment: { backendIdFor: () => 'local', refusalFor: () => null } });
reg.register(made.execTool);
const shellExec = reg.get('shell.exec');
const call = args => ({ id: 'c1', name: 'shell.exec', args: args, argsRaw: JSON.stringify(args) });
const ready = { status: 'ready' };
A.eq([shellExec.name, shellExec.scope, shellExec.requiresConsent], ['shell.exec', 'execute', true], 'C: the registered shell.exec is still an execute-scope tool that asks for approval');
// canMutate is untouched: it holds every look, which is what the gate does with the switch off
for (const cmd of LOOKS) A.eq(Policy.canMutate(ready, shellExec, call({ cmd })).ok, false, 'C: canMutate still holds shell.exec ' + JSON.stringify(cmd) + ' (switch off = this answer)');
A.eq(Policy.canMutate(ready, shellExec, call({ cmd: 'ls' })).reason, 'settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work', 'C: ...with the reason it always gave');
A.eq(Policy.canMutate.length, 3, 'C: canMutate takes no switch');
for (const cmd of LOOKS) A.eq(Policy.looksOnly(ready, shellExec, call({ cmd })), true, 'C: looksOnly passes shell.exec ' + JSON.stringify(cmd) + ' while the brief is open');
for (const [cmd, what] of HELD) A.eq(Policy.looksOnly(ready, shellExec, call({ cmd })), false, 'C: looksOnly holds (' + what + ') ' + JSON.stringify(cmd));
for (const status of ['clarifying', 'done', 'cancelled', 'draft', '', undefined]) A.eq(Policy.looksOnly({ status }, shellExec, call({ cmd: 'ls' })), false, 'C: a brief that is ' + JSON.stringify(status) + ' (a question is open, or it is closed) holds the look');
A.eq(Policy.looksOnly({ status: 'executing' }, shellExec, call({ cmd: 'ls' })), false, 'C: a settled brief needs no exception (canMutate already passes it)');
A.eq(Policy.canMutate({ status: 'executing' }, shellExec, call({ cmd: 'rm -rf x' })).ok, true, 'C: ...as before');
// only shell.exec, whatever its arguments look like
for (const name of ['verify.run', 'terminal.start', 'terminal.write', 'shell.bg.write', 'shell.bg.kill', 'code.run', 'fs.write', 'shell_exec', 'shell.exec2', 'mcp__x__shell_exec', '', undefined])
  A.eq(Policy.looksOnly(ready, { name, scope: 'execute' }, call({ cmd: 'ls' })), false, 'C: ' + JSON.stringify(name) + ' is never passed by this rule');
A.eq([Policy.looksOnly(ready, shellExec), Policy.looksOnly(ready, shellExec, {}), Policy.looksOnly(ready, shellExec, { args: null }), Policy.looksOnly(null, shellExec, call({ cmd: 'ls' })), Policy.looksOnly(ready, null, call({ cmd: 'ls' }))],
  [false, false, false, false, false], 'C: no call, no arguments, no brief or no tool: held');
{
  // it settles nothing: the brief object is not touched, so the next write is held as before
  const brief = { id: 'b1', status: 'ready', questions: [] };
  const before = JSON.stringify(brief);
  Policy.looksOnly(brief, shellExec, call({ cmd: 'git status' }));
  A.eq(JSON.stringify(brief), before, 'C: a look leaves the brief exactly as it was');
  A.eq(Policy.canMutate(brief, { name: 'fs.write', scope: 'write' }, { args: { path: 'a', content: 'b' } }).ok, false, 'C: ...and the write after it still waits for brief_proceed');
  A.eq(Policy.canMutate(brief, shellExec, call({ cmd: 'npm test' })).ok || Policy.looksOnly(brief, shellExec, call({ cmd: 'npm test' })), false, 'C: ...and so does a shell call that is not a look');
}

/* ---- D. THE SWITCH AND THE ONE PLACE THAT READS IT ------------------------------------------------------------------ */
{
  const idx = require('./helpers/source.js').readSidecarSource();   // the sidecar's source through the helper (source-helper H5)
  const envLine = (idx.match(/^function ENV\(suffix\) \{.*\}$/m) || [''])[0];
  const readLine = (idx.match(/^function briefReadOnlyShell\(\) \{.*\}$/m) || [''])[0];
  A.ok(!!envLine && !!readLine, 'D: index.js has ENV() and briefReadOnlyShell()');
  const on = env => new Function('process', envLine + '\n' + readLine + '\nreturn briefReadOnlyShell();')({ env });   // eslint-disable-line no-new-func
  let read = null;
  try {
    read = [{}, { STARNET_BRIEF_READONLY_SHELL: '1' }, { STARNET_BRIEF_READONLY_SHELL: '0' }, { STARNET_BRIEF_READONLY_SHELL: '' }, { STARNET_BRIEF_READONLY_SHELL: ' 1 ' },
      { SKYNET_BRIEF_READONLY_SHELL: '1' }, { STARNET_BRIEF_READONLY_SHELL: '', SKYNET_BRIEF_READONLY_SHELL: '1' }, { STARNET_BRIEF_READONLY_SHELL: '0', SKYNET_BRIEF_READONLY_SHELL: '1' },
      { STARNET_BRIEF_READONLY_SHELL: 'off' }, { STARNET_BRIEF_READONLY_SHELL: 'maybe' }, { STARNET_BRIEF_READONLY_SHELL: 'on' }].map(on);
  } catch (e) { read = 'threw: ' + e.message; }
  A.eq(read, [false, true, false, false, true, true, false, false, false, false, true],
    'D: the switch is off unless it is set on: unset, blank, 0 or an unknown word is off; STARNET_ wins (a blank or 0 one too), SKYNET_ is the fallback');
  A.eq((idx.match(/ENV\('BRIEF_READONLY_SHELL'\)/g) || []).length, 1, 'D: the switch is read in one place');
  A.eq((idx.match(/briefReadOnlyShell\(\)/g) || []).length, 2, 'D: ...one definition and one call (per run)');
  A.eq((idx.match(/TaskBriefPolicy\.looksOnly\(/g) || []).length, 1, 'D: the rule is asked in one place');
  const hold = A.fnBody(idx, 'const briefHoldFor = (c, liveTool) =>');
  A.ok(hold.length > 200 && hold.length < 4000, 'D: briefHoldFor was found (' + hold.length + ' chars)');
  A.ok(hold.indexOf('const gate = TaskBriefPolicy.canMutate(taskBriefState.brief, liveTool, c);') >= 0, 'D: the gate is asked exactly as before');
  A.ok(hold.indexOf('if (!gate.ok && briefLooksPass && TaskBriefPolicy.looksOnly(taskBriefState.brief, liveTool, c)) return null;') > hold.indexOf('const gate = '),
    'D: the exception is asked only for a call the gate holds, only with the switch on');
  A.ok(/const briefLooksPass = briefReadOnlyShell\(\);\s*\n\s*const briefHoldFor = /.test(idx), 'D: the switch is read once per run, beside the hold');
  // nothing else in the sidecar reads the switch or the classifier
  const hits = [];
  const walk = dir => { for (const name of fs.readdirSync(dir)) { if (name === 'node_modules') continue; const p = path.join(dir, name); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(name)) hits.push(p); } };
  walk(path.join(__dirname, '..', 'sidecar'));
  const rel = p => path.relative(path.join(__dirname, '..', 'sidecar'), p).split(path.sep).join('/');
  const reading = hits.filter(p => /BRIEF_READONLY_SHELL['"\]]/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  A.eq(reading, ['index.js'], 'D: only index.js reads the switch');
  const requiring = hits.filter(p => /require\([^)]*readonly-shell/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  A.eq(requiring, ['taskbrief-policy.js'], 'D: only the Task Brief policy loads the classifier (approvals, the fence and the taint lock never see it)');
}

/* ---- E. THE OTHER PROTECTIONS DO NOT READ THE CLASSIFIER ------------------------------------------------------------ */
{
  // commands that pass as a look, and what the shell's own floor says about them: the same refusal as ever
  const outside = [['cat ../secret.txt', /parent-directory/], ['type ..\\secret.txt', /parent-directory/], ['dir "C:\\Users"', /drive-absolute/], ['cat C:/Windows/win.ini', /drive-absolute/],
    ['cat agent.roster.json', /protected harness control file/], ['type permissions.allow', /protected harness control file/]];
  for (const [cmd, why] of outside) {
    A.ok(looks(cmd), 'E: ' + JSON.stringify(cmd) + ' reads as a look');
    A.ok(why.test(String(Shell.escapesWorkspace(cmd))), 'E: ...and the workspace floor still refuses it: ' + Shell.escapesWorkspace(cmd));
  }
  // and the tool itself refuses it when run: passing the Task Brief gate is not passing the fence
  let refusal = '';
  try { made.execTool.run({ cmd: 'cat ../secret.txt' }, { agentId: 'agent' }); } catch (e) { refusal = String(e && e.message); }
  A.ok(/^refused: parent-directory/.test(refusal), 'E: shell.exec refuses the look that leaves the workspace: ' + refusal);
}

/* ---- F. THE REAL SHELL AGREES ------------------------------------------------------------------------------------------
   The classifier reads flags off its own split of the line. That is only sound if the shell that will run the line hands
   the program no flag the classifier did not see. Ask this machine's shell (cmd.exe on Windows, sh elsewhere: the two
   shell.exec uses): run every passing line with the program swapped for a script that prints its argv, and compare the
   words that start with `-`. The same check on the one shape the classifier holds for cmd.exe's sake shows why. */
{
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ro-argv-'));
  try {
    const script = path.join(dir, 'argv.js');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const q = s => '"' + s + '"';
    const argvOf = line => {
      const t = line.trim(), sp = t.indexOf(' ');
      const r = spawnSync(q(process.execPath) + ' ' + q(script) + (sp < 0 ? '' : t.slice(sp)), { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      try { return JSON.parse(r.stdout); } catch (_) { return null; }
    };
    const flagsSeen = line => RO._internals.words(line.trim()).slice(1).filter(w => !w.quoted && w.text.charAt(0) === '-').map(w => w.text);
    const probe = argvOf('x one "two words" -n');
    A.eq(probe, ['one', 'two words', '-n'], 'F: the argv probe runs through this machine\'s shell');
    const wrong = [];
    if (probe) for (const line of LOOKS) {
      const real = argvOf(line);
      const dashed = real ? real.filter(a => String(a).charAt(0) === '-') : null;
      if (JSON.stringify(dashed) !== JSON.stringify(flagsSeen(line))) wrong.push(JSON.stringify(line) + ' shell ' + JSON.stringify(dashed) + ' vs classifier ' + JSON.stringify(flagsSeen(line)));
    }
    A.eq(wrong, [], 'F: for every passing line, the flags the real shell hands the program are exactly the ones the classifier vetted (' + LOOKS.length + ' lines, ' + process.platform + ')');
    // cmd.exe does not read ' as a quote: a flag inside single quotes reaches the program there. That shape is held.
    const hidden = argvOf('rg \'x --pre=evil\'');
    if (process.platform === 'win32') A.ok(Array.isArray(hidden) && hidden.some(a => /^--pre=evil/.test(a)), 'F: on cmd.exe a flag inside single quotes reaches the program: ' + JSON.stringify(hidden));
    else A.eq(hidden, ['x --pre=evil'], 'F: sh keeps single-quoted words whole');
    A.ok(!looks('rg \'x --pre=evil\''), 'F: ...so the classifier holds that line on every platform');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp folder left behind fails nothing */ }
  }
}

A.report('taskbrief.readonly-shell');
