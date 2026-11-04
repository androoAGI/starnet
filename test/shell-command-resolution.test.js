'use strict';
const A = require('./_assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadShell, windowsRig } = require('./helpers/shell-guard-fixture');
const api = loadShell();

function pe(kind) {
  const b = Buffer.alloc(512);
  b.write('MZ'); b.writeUInt32LE(128, 0x3c); b.write('PE\0\0', 128);
  b.writeUInt16LE(0x20b, 152); b.writeUInt16LE(kind, 220);
  return b;
}
const consolePE = pe(3), guiPE = pe(2);
function fixture(files, faults) {
  const table = new Map(Object.entries(files).map(([f, b]) => [f.toLowerCase(), b]));
  const handles = new Map(), touched = [];
  const key = f => String(f).toLowerCase();
  const read = f => {
    const code = (faults || {})[key(f)];
    if (code || !table.has(key(f))) throw Object.assign(new Error(code || 'ENOENT'), { code: code || 'ENOENT' });
    return table.get(key(f));
  };
  const memory = {
    statSync(f) { touched.push(String(f)); const b = read(f); return { isFile: () => true, size: b.length }; },
    existsSync(f) { return table.has(key(f)); },
    readFileSync(f) { return read(f); },
    openSync(f) { const fd = handles.size + 10; handles.set(fd, read(f)); return fd; },
    readSync(fd, b, off, len, pos) { return handles.get(fd).copy(b, off, pos, pos + len); },
    closeSync(fd) { handles.delete(fd); }, readdirSync() { return []; }
  };
  return { memory, touched, handles };
}
function at(files, env, faults) {
  const f = fixture(files, faults);
  const opts = { cwd: 'C:\\work', exactCwd: true, fs: f.memory, pathMod: path.win32, isWin: true, dialect: 'cmd', env: Object.assign({ PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, env) };
  return Object.assign(f, { opts, risk: (cmd, extra) => api.commandSafetyRisk(cmd, Object.assign({}, opts, extra)) });
}

const base = at({
  'C:\\work\\probe.exe': guiPE,
  'C:\\work\\1.exe': guiPE,
  'C:\\work\\probe name.exe': guiPE,
  'C:\\work\\probe.v1.exe': guiPE,
  'C:\\work\\π-probe.exe': guiPE,
  'C:\\bin\\console-probe.exe': consolePE,
  'C:\\bin\\console name.exe': consolePE,
  'C:\\bin\\console.v1.exe': consolePE,
  'C:\\bin\\π-console.exe': consolePE,
  'C:\\bin\\console\'name.exe': consolePE,
  'C:\\work\\echo.exe': guiPE,
  'C:\\bin\\devshim.cmd': Buffer.from('@echo developer-safe\n'),
  'C:\\bin\\dev shim.cmd': Buffer.from('@echo developer-safe\n'),
  'C:\\bin\\unsafe.cmd': Buffer.from('@echo off\nnotepad forbidden.txt\n'),
  'C:\\bin\\npm.cmd': Buffer.from('@echo package shim\n'),
  'C:\\work\\package.json': Buffer.from(JSON.stringify({ scripts: { check: 'echo checked', unsafe: 'notepad forbidden.txt' } }))
});
for (const cmd of ['probe', '(probe.exe)', 'probe.ex^e', '@probe', '@@probe', '@ @probe', '@(probe.exe)', '@ (probe.exe)', '@@(probe.exe)', '"probe name"', 'probe.v1', 'π-probe', '(echo first & probe)', 'echo first & probe']) {
  A.ok(base.risk(cmd), 'normalized executable spelling cannot bypass proof: ' + cmd);
}
for (const cmd of ['console-probe', 'console-probe.ex^e', '@@console-probe', '"console name"', 'console.v1', 'π-console', '"console\'name"', 'echo harmless', '(echo harmless)', '@(echo harmless)', '@ (echo harmless)', 'echo (probe.exe)', 'devshim', 'devshim.cmd', '"dev shim"', 'npm run check']) {
  A.eq(base.risk(cmd), null, 'genuine builtin/console/readable developer positive: ' + cmd);
}
A.ok(base.risk('unsafe'), 'resolved .cmd bytes reach the existing GUI launch source scan');
A.ok(base.risk('npm run unsafe'), 'package script scanning survives the resolved developer shim');
A.ok(base.risk('console-probe', { exactCwd: false }), 'a live terminal write cannot claim the stored starting cwd is current');
A.ok(/shell\.exec/.test((base.risk('console-probe', { exactCwd: false }) || {}).reason || ''), 'unknown-cwd refusal names the known-cwd execution owner');
A.eq(base.risk('echo harmless', { exactCwd: false }), null, 'a native builtin needs no external file proof');
A.ok(base.risk('(console-probe.exe)'), 'a group does not acquire direct-program proof');
A.ok(base.risk('echo x & console-probe'), 'a later bare external cannot use an earlier cwd snapshot');
for (const cmd of ['console-probe 2>&1', 'console-probe 2>&1 > out.txt', 'console-probe 1>&2', 'echo harmless 2>&1']) A.eq(base.risk(cmd), null, 'descriptor duplication is not an executable head: ' + cmd);
for (const cmd of ['console-probe 2>&1 & probe', 'echo harmless 2>&1 && probe', 'console-probe 2>&1 | probe']) A.ok(base.risk(cmd), 'a real separator after redirection still exposes the next program: ' + cmd);
for (const cmd of ['echo harmless ^>&1', 'echo harmless 2^>&1', 'echo harmless ^^^>&1']) A.ok(base.risk(cmd), 'escaped redirection operator leaves a real separator/numeric executable: ' + cmd);
A.eq(base.risk('echo harmless ^^>&1'), null, 'even carets leave an active redirection operator, not a numeric command');
for (const cmd of ['tools\\probe', 'probe%SUFFIX%', 'probe!SUFFIX!', '"\\\\server\\share\\probe"']) A.ok(base.risk(cmd), 'unproven path/dynamic head cannot use a lexical exemption: ' + cmd);
A.eq(base.risk('definitely-absent'), null, 'a definitely absent command is left to cmd to report, without pretending it is a console program');

const cwdFirst = at({ 'C:\\work\\same.exe': guiPE, 'C:\\bin\\same.exe': consolePE });
A.ok(cwdFirst.risk('same'), 'PATH console copy cannot vouch for cwd GUI');
const pathFirst = at({ 'C:\\bin\\same.exe': guiPE, 'C:\\later\\same.exe': consolePE }, { PATH: 'C:\\bin;C:\\later' });
A.ok(pathFirst.risk('same'), 'later PATH console copy cannot vouch for first PATH GUI');
const extensionFirst = at({ 'C:\\work\\same.com': guiPE, 'C:\\work\\same.exe': consolePE });
A.ok(extensionFirst.risk('same'), 'PATHEXT first candidate owns the decision');
A.eq(extensionFirst.risk('same', { env: { PATH: '', PATHEXT: '.EXE;.COM' } }), null, 'the actual alternate PATHEXT order selects the console candidate');
for (const ext of ['.exe', '.com']) {
  A.ok(at({ 'C:\\work\\same': consolePE, ['C:\\work\\same' + ext]: guiPE }).risk('same'), 'raw console file cannot vouch for PATHEXT GUI ' + ext);
  A.eq(at({ 'C:\\work\\same': guiPE, ['C:\\work\\same' + ext]: consolePE }).risk('same'), null, 'ignored raw GUI file does not refuse actual console ' + ext);
}
A.eq(at({ 'C:\\work\\same.tag': consolePE, 'C:\\work\\same.tag.exe': guiPE }).risk('same.tag'), null, 'exact dotted console file precedes appended GUI');
A.ok(at({ 'C:\\work\\same.tag': guiPE, 'C:\\work\\same.tag.exe': consolePE }).risk('same.tag'), 'exact dotted GUI cannot be vouched for by appended console');
const unreadable = at({ 'C:\\bin\\same.exe': consolePE }, {}, { 'c:\\work\\same.com': 'EACCES' });
A.ok(unreadable.risk('same'), 'unreadable earlier candidate is unproven');
A.ok(!unreadable.touched.some(f => /^C:\\bin/i.test(f)), 'no later file is used after unreadable ownership');
const network = at({}, { PATH: '\\\\server\\share;C:\\bin' });
A.ok(network.risk('same'), 'earlier network search location is unproven');
A.ok(network.touched.every(f => !/^[\\/]{2}/.test(f)), 'no stat/open/read reaches a network path');
const unknownScript = at({ 'C:\\bin\\script.cmd': Buffer.from('@echo safe\n') });
unknownScript.memory.readFileSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
A.ok(unknownScript.risk('script'), 'an unreadable batch source is not accepted as a developer shim');

// ---- the folder cmd searches first is not always the working folder ----
// Read off the real cmd.exe by the Windows block below: with NoDefaultCurrentDirectoryInExePath defined, whatever its value
// (even none) and however its name is cased, a bare program name is looked for along PATH only. The guard reads the variable
// from the environment the command will run with, so a console copy in the working folder cannot vouch for the GUI program
// PATH runs, and a GUI copy cmd never reads cannot refuse the console program it does.
const NO_CWD = { NoDefaultCurrentDirectoryInExePath: '1' };
const safeShim = Buffer.from('@echo safe\n'), unsafeShim = Buffer.from('@echo off\nnotepad forbidden.txt\n');
A.ok(at({ 'C:\\work\\same.exe': consolePE, 'C:\\bin\\same.exe': guiPE }, NO_CWD).risk('same'), 'variable defined: a console copy in the working folder cannot vouch for the GUI program PATH runs');
A.eq(at({ 'C:\\work\\same.exe': guiPE, 'C:\\bin\\same.exe': consolePE }, NO_CWD).risk('same'), null, 'variable defined: the working-folder GUI copy is never run, PATH\'s console copy is');
A.eq(at({ 'C:\\work\\same.exe': guiPE }, NO_CWD).risk('same'), null, 'variable defined and nothing on PATH: cmd reports it is not recognized and runs nothing');
for (const spelling of [{ NoDefaultCurrentDirectoryInExePath: '' }, { nodefaultcurrentdirectoryinexepath: '1' }, { NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' }]) {
  A.eq(at({ 'C:\\work\\same.exe': guiPE, 'C:\\bin\\same.exe': consolePE }, spelling).risk('same'), null, 'defined is defined, whatever the value or the case of the name: ' + JSON.stringify(spelling));
}
A.eq(at({ 'C:\\work\\pair.exe': guiPE, 'C:\\bin\\pair.exe': consolePE }, NO_CWD).risk('pair.exe'), null, 'variable defined: a program spelled with its .exe is searched the same way');
A.ok(at({ 'C:\\work\\shim.cmd': safeShim, 'C:\\bin\\shim.cmd': unsafeShim }, NO_CWD).risk('shim'), 'variable defined: the batch shim that runs is the PATH one, and its source is the one scanned');
A.eq(at({ 'C:\\work\\shim.cmd': unsafeShim, 'C:\\bin\\shim.cmd': safeShim }, NO_CWD).risk('shim'), null, 'variable defined: a working-folder shim cmd never reads is not scanned');
A.ok(at({}, { PATH: ';C:\\bin', NoDefaultCurrentDirectoryInExePath: '1' }).risk('same'), 'variable defined: an empty PATH entry is not read as the working folder, so it is unproven');
A.ok(at({ 'C:\\work\\same.exe': guiPE, 'C:\\bin\\same.exe': consolePE }).risk('same'), 'control, variable undefined: the working folder answers first and its GUI copy is refused');

// ---- where cmd ends a program name ----
// Read off the real cmd.exe (Windows block below): the name stops at , ; = ( and at a space of any width, so `probe,x` runs
// probe.exe with the argument ,x. A name that holds one is not the file the guard would look up under that spelling.
for (const cmd of ['probe,x', 'probe=x', 'probe(x', 'probe.exe,x', 'probe.exe=x', 'probe\u0085x', 'probe\u180ex', 'console-probe,x', 'console-probe=x']) {
  A.ok(base.risk(cmd), 'a name cmd would cut short is not looked up as spelled: ' + JSON.stringify(cmd));
}
A.eq(base.handles.size, 0, 'all PE file handles close');

// ---- the tools give the guard the environment the command will run with ----
// shell.exec and verify.run ask the execution environment what its commands begin from (commandEnv; a rig may hand the tool its own
// env), and terminal.start reads the env its PTY is given (envFor). The same folder holds a console copy and PATH a GUI one: only
// the environment says which of them runs.
const plumbing = (async () => {
  const { makeVerifyTool } = require('../sidecar/tools/builtin/verify.js');
  const { makeTerminalTools } = require('../sidecar/tools/builtin/terminal.js');
  const ws = 'C:\\ws', mine = 'C:\\ws\\ag';
  const files = { 'C:\\ws\\ag\\same.exe': consolePE, 'C:\\bin\\same.exe': guiPE };
  const searched = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE' }, defined = Object.assign({ NoDefaultCurrentDirectoryInExePath: '1' }, searched);
  const ctx = { agentId: 'ag', surface: 'interactive' };
  const attempt = async run => { try { await run(); return null; } catch (e) { return String((e && e.message) || e); } };
  const quietSpawn = log => function (cmd, o) {
    log.push({ cmd, env: o && o.env });
    const on = {};
    setImmediate(() => on.close && on.close(0));
    return { pid: 4242, stdout: { on() {} }, stderr: { on() {} }, on(ev, fn) { on[ev] = fn; }, kill() {} };
  };
  const fakeEnvironment = (answer, seen, ran) => ({
    backendId: 'local', ensureWorkspace: () => mine, getCwd: () => mine, workspaceRoot: () => mine, rememberCwd() {},
    commandEnv: o => { seen.push(o); return answer(); },
    execute: o => { ran.push(o.cmd); return Promise.resolve({ exitCode: 0, out: '', fullOut: '', ms: 1, truncated: false, timedOut: false, aborted: false }); }
  });
  const memory = () => fixture(files).memory;

  // shell.exec: the execution environment's own answer
  {
    let answer = defined; const seen = [], ran = [];
    const tool = api.makeShellTool({ environment: fakeEnvironment(() => answer, seen, ran), fs: memory(), pathMod: path.win32, root: ws, platform: 'win32' }).execTool;
    A.ok(/refused \[user-control\]/.test(await attempt(() => tool.run({ cmd: 'same' }, ctx)) || ''), 'shell.exec, variable defined in the environment the command begins from: the PATH GUI copy that runs is refused');
    A.eq(ran.length, 0, 'and nothing was dispatched');
    A.eq(seen[0] && seen[0].agentId, 'ag', 'the execution environment is asked about this agent');
    A.eq(seen[0] && seen[0].surface, 'interactive', 'and this run\'s surface');
    answer = searched;
    A.eq(await attempt(() => tool.run({ cmd: 'same' }, ctx)), null, 'shell.exec, variable not defined there: the working-folder console copy answers first and runs');
    A.eq(ran.length, 1, 'and it was dispatched');
  }
  // shell.exec: no execution environment, the tool's own
  {
    const log = [];
    const withEnv = env => api.makeShellTool({ spawn: quietSpawn(log), fs: memory(), pathMod: path.win32, root: ws, platform: 'win32', env }).execTool;
    A.ok(/refused \[user-control\]/.test(await attempt(() => withEnv(defined).run({ cmd: 'same' }, ctx)) || ''), 'shell.exec given its own env with the variable defined: refused');
    A.eq(log.length, 0, 'and not spawned');
    A.eq(await attempt(() => withEnv(searched).run({ cmd: 'same' }, ctx)), null, 'shell.exec given its own env without it: runs');
    A.eq(log.length, 1, 'and was spawned');
    A.eq(log[0] && log[0].env, searched, 'with exactly the environment the guard searched in');
  }
  // verify.run
  {
    let answer = defined; const seen = [], ran = [];
    const tool = makeVerifyTool({ environment: fakeEnvironment(() => answer, seen, ran), fs: memory(), pathMod: path.win32, root: ws, platform: 'win32' }).verifyTool;
    A.ok(/refused \[user-control\]/.test(await attempt(() => tool.run({ cmd: 'same' }, ctx)) || ''), 'verify.run, variable defined in the environment the check begins from: refused');
    A.eq(ran.length, 0, 'and not dispatched');
    answer = searched;
    A.eq(await attempt(() => tool.run({ cmd: 'same' }, ctx)), null, 'verify.run, variable not defined there: runs');
    A.eq(ran.length, 1, 'and was dispatched');
  }
  // terminal.start: the PTY's own environment
  {
    let current = defined; const started = [];
    const manager = { start: o => { started.push(o); return { ok: true, persisted: true, session: { name: 't', sessionId: 's1', state: 'running', cols: 80, rows: 24 } }; } };
    const start = makeTerminalTools({ manager, environment: fakeEnvironment(() => null, [], []), fs: memory(), pathMod: path.win32, root: ws, platform: 'win32', envFor: () => current }).tools.find(t => t.name === 'terminal.start');
    A.ok(/refused \[user-control\]/.test(await attempt(() => start.run({ name: 't', command: 'same' }, ctx)) || ''), 'terminal.start, variable defined in the PTY environment: refused');
    A.eq(started.length, 0, 'and no PTY was opened');
    current = searched;
    A.eq(await attempt(() => start.run({ name: 't', command: 'same' }, ctx)), null, 'terminal.start, variable not defined there: starts');
    A.eq(started.length, 1, 'and the PTY was opened');
    A.eq(started[0] && started[0].env, searched, 'in the environment the guard searched in');
  }
})();

if (process.platform === 'win32') {
  const rig = windowsRig(api);
  try {
    const control = rig.execute('.\\probe.exe', true);
    A.eq(control.run.status, 0, 'harmless GUI marker transport control exits');
    A.eq(control.marker, true, 'real GUI subsystem fixture is executable');
    for (const cmd of ['probe', '(probe.exe)', 'probe.ex^e', '@(probe.exe)', '@ (probe.exe)', '@@(probe.exe)']) {
      const r = rig.execute(cmd);
      A.ok(r.risk, 'actual native spelling is refused: ' + cmd);
      A.eq(r.run, null, 'refused native spelling is never dispatched: ' + cmd);
      A.eq(r.marker, false, 'refused native spelling writes no marker: ' + cmd);
    }
    for (const name of ['probe name', 'probe.v1', 'π-probe']) fs.copyFileSync(path.join(rig.root, 'probe.exe'), path.join(rig.root, name + '.exe'));
    for (const cmd of ['"probe name"', 'probe.v1', 'π-probe', '@@probe', '@ @probe']) {
      const r = rig.execute(cmd);
      A.ok(r.risk, 'actual filename/suppression spelling is refused: ' + cmd);
      A.eq(r.run, null, 'no native dispatch for that refused spelling');
      A.eq(r.marker, false, 'no marker from that refused spelling');
    }
    for (const name of ['console name', 'console.v1', 'π-console', "console'name"]) fs.copyFileSync(path.join(rig.root, 'console-probe.exe'), path.join(rig.root, name + '.exe'));
    fs.writeFileSync(path.join(rig.root, 'devshim.cmd'), '@echo developer-safe\r\n');
    fs.writeFileSync(path.join(rig.root, 'dev shim.cmd'), '@echo developer-safe\r\n');
    for (const cmd of ['console-probe', 'console-probe.ex^e', '@@console-probe', '"console name"', 'console.v1', 'π-console', '"console\'name"', '(echo group-safe)', '@(echo group-safe)', '@ (echo group-safe)', 'echo (probe.exe)', 'devshim', '"dev shim"']) {
      const r = rig.execute(cmd);
      A.eq(r.risk, null, 'real developer/native positive accepted: ' + cmd);
      A.ok(r.run && r.run.status === 0, 'real developer/native positive executes: ' + cmd);
      A.eq(r.marker, /console/.test(cmd), 'only the explicit console marker runs: ' + cmd);
    }
    for (const cmd of ['console-probe 2>&1', 'console-probe 2>&1 > redirect.txt', 'console-probe 1>&2', 'echo redirected 2>&1']) {
      const r = rig.execute(cmd);
      A.eq(r.risk, null, 'actual descriptor redirect is allowed: ' + cmd);
      A.ok(r.run && r.run.status === 0, 'redirected console/builtin transport completes');
      A.eq(r.markerKind, /^console/.test(cmd) ? 'console' : null, 'redirect does not change program ownership');
      if (r.run && cmd === 'console-probe 2>&1') {
        A.ok(/owned-stdout/.test(r.run.stdout) && /owned-stderr/.test(r.run.stdout), 'both actual streams arrive on stdout');
        A.eq(r.run.stderr, '', 'no actual stderr remains after 2>&1');
      }
      if (r.run && cmd === 'console-probe 1>&2') A.ok(/owned-stdout/.test(r.run.stderr) && /owned-stderr/.test(r.run.stderr), 'both actual streams arrive on stderr');
      if (r.run && cmd === 'console-probe 2>&1 > redirect.txt') {
        A.ok(/owned-stdout/.test(fs.readFileSync(path.join(rig.root, 'redirect.txt'), 'utf8')), 'ordered redirect sends actual stdout to the allocated file');
        A.ok(/owned-stderr/.test(r.run.stdout), 'earlier stderr duplication retains its actual destination');
      }
      if (r.run && cmd === 'echo redirected 2>&1') A.ok(/redirected/.test(r.run.stdout), 'native builtin stdout survives its redirect');
    }
    const separated = rig.execute('echo harmless 2>&1 & probe');
    A.ok(separated.risk, 'actual real separator after redirection is refused');
    A.eq(separated.run, null, 'separator negative does not dispatch the GUI marker');
    A.eq(separated.marker, false, 'separator negative produces no marker');
    fs.copyFileSync(path.join(rig.root, 'probe.exe'), path.join(rig.root, '1.exe'));
    for (const cmd of ['echo harmless ^>&1', 'echo harmless 2^>&1', 'echo harmless ^^^>&1']) {
      const observed = rig.execute(cmd, true);
      A.eq(observed.markerKind, 'gui', 'actual odd-caret command executes the harmless numeric GUI marker: ' + cmd);
      const guarded = rig.execute(cmd);
      A.ok(guarded.risk, 'odd-caret numeric command is refused');
      A.eq(guarded.run, null, 'refused numeric command is never dispatched');
      A.eq(guarded.marker, false, 'no numeric marker after guarded refusal');
    }
    const even = rig.execute('echo harmless ^^>&1', true);
    A.eq(even.risk, null, 'even-carets descriptor form is not a numeric executable');
    A.eq(even.marker, false, 'actual even-carets command does not execute numeric GUI marker');
    // cmd ends a program name at a comma or an equals sign: each spelling really runs probe.exe (forced, inert marker), and the
    // guard refuses both before anything is dispatched.
    for (const cmd of ['probe,x', 'probe=x']) {
      const observed = rig.execute(cmd, true);
      A.eq(observed.markerKind, 'gui', 'actual cmd cuts the name short and runs probe.exe: ' + cmd);
      const guarded = rig.execute(cmd);
      A.ok(guarded.risk, 'a name cmd would cut short is refused: ' + cmd);
      A.eq(guarded.run, null, 'refused, never dispatched: ' + cmd);
      A.eq(guarded.marker, false, 'no marker from it: ' + cmd);
    }
    // Native cmd reports a handle-duplication error for this form on this host.
    // Only absence of a second executable is claimed; successful stream routing
    // is proven above by the ordinary 2>&1 / 1>&2 and ordered file cases.
    //
    // Which file a bare name reaches, in the two search contexts real cmd has: the working folder first and then PATH, and, with
    // NoDefaultCurrentDirectoryInExePath defined, PATH alone (here cwd/bin;cwd/later). `actual` and `noCwd` name the kind of
    // file cmd runs in each, null when it finds nothing. Every row is read off a real run when the working folder is searched;
    // `watch` rows are read off one when the variable is defined too, and the other cells are held to the same verdict without a
    // process. `only` marks a spelling the guard reads on purpose in more places than cmd (it keeps a copy beside the command
    // from vouching for one on PATH) and so compares only where the two agree.
    const lookups = [
      { id: 'raw-console-exe-gui', cmd: 'pick', files: { pick: 'console', 'pick.exe': 'gui' }, actual: 'gui', noCwd: null, watch: true },
      { id: 'raw-gui-exe-console', cmd: 'pick', files: { pick: 'gui', 'pick.exe': 'console' }, actual: 'console', noCwd: null },
      { id: 'raw-console-com-gui', cmd: 'pick', files: { pick: 'console', 'pick.com': 'gui' }, actual: 'gui', noCwd: null },
      { id: 'raw-gui-com-console', cmd: 'pick', files: { pick: 'gui', 'pick.com': 'console' }, actual: 'console', noCwd: null },
      { id: 'dotted-console-appended-gui', cmd: 'pick.tag', files: { 'pick.tag': 'console', 'pick.tag.exe': 'gui' }, actual: 'console', noCwd: null },
      { id: 'dotted-gui-appended-console', cmd: 'pick.tag', files: { 'pick.tag': 'gui', 'pick.tag.exe': 'console' }, actual: 'gui', noCwd: null },
      { id: 'cwd-batch-path-console', cmd: 'pick', files: { 'pick.cmd': 'batch', 'bin/pick.exe': 'console' }, actual: 'batch', noCwd: 'console', watch: true },
      { id: 'cwd-console-path-gui', cmd: 'pick', files: { 'pick.exe': 'console', 'bin/pick.com': 'gui' }, actual: 'console', noCwd: 'gui', watch: true },
      { id: 'first-path-batch-later-gui', cmd: 'pick', files: { 'bin/pick.cmd': 'batch', 'later/pick.exe': 'gui' }, actual: 'batch', noCwd: 'batch' },
      { id: 'custom-pathext', cmd: 'pick', files: { 'pick.com': 'gui', 'pick.exe': 'console' }, actual: 'console', noCwd: null, pathext: '.EXE;.COM;.CMD;.BAT' },
      { id: 'cwd-gui-path-console', cmd: 'pick', files: { 'pick.exe': 'gui', 'bin/pick.exe': 'console' }, actual: 'gui', noCwd: 'console', watch: true },
      { id: 'exe-cwd-console-path-gui', cmd: 'pick.exe', files: { 'pick.exe': 'console', 'bin/pick.exe': 'gui' }, actual: 'console', noCwd: 'gui', watch: true, only: 'defined' },
      { id: 'exe-cwd-gui-path-console', cmd: 'pick.exe', files: { 'pick.exe': 'gui', 'bin/pick.exe': 'console' }, actual: 'gui', noCwd: 'console', only: 'defined' }
    ];
    const withoutVariable = env => { for (const k of Object.keys(env)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[k]; return env; };
    for (const row of lookups) {
      const cwd = path.join(rig.root, row.id); fs.mkdirSync(cwd);
      for (const [name, kind] of Object.entries(row.files)) {
        const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), { recursive: true });
        if (kind === 'batch') fs.writeFileSync(target, '@echo batch>"%STARNET_SHELL_MARKER%"\r\n');
        else fs.copyFileSync(path.join(rig.root, kind === 'gui' ? 'probe.exe' : 'console-probe.exe'), target);
      }
      const searched = withoutVariable(Object.assign({}, rig.env, { PATH: [path.join(cwd, 'bin'), path.join(cwd, 'later')].join(';'), PATHEXT: row.pathext || rig.env.PATHEXT }));
      const defined = Object.assign({}, searched, { NoDefaultCurrentDirectoryInExePath: '1' });
      for (const cell of [
        { mode: 'working folder searched', env: searched, expected: row.actual, observe: true, skip: row.only === 'defined' },
        { mode: 'variable defined', env: defined, expected: row.noCwd, observe: row.watch === true }
      ]) {
        if (cell.skip) continue;
        const where = row.id + ' (' + cell.mode + ')', launch = { cwd, env: cell.env };
        if (cell.expected === 'gui') {
          if (cell.observe) {
            // The one place a GUI marker is started on purpose: its inert image only, to read which file cmd really runs.
            const seen = rig.execute(row.cmd, true, launch);
            A.eq(seen.run.status, 0, 'native lookup completed: ' + where);
            A.eq(seen.markerKind, 'gui', 'actual cmd owns this candidate: ' + where);
          }
          const refused = rig.execute(row.cmd, false, launch);
          A.ok(refused.risk, 'the actual GUI candidate is refused: ' + where);
          A.eq(refused.marker, false, 'guard prevents that actual GUI marker: ' + where);
        } else if (cell.observe) {
          // Allowed, so the guard dispatches it itself and the marker shows which candidate cmd ran.
          const ran = rig.execute(row.cmd, false, launch);
          A.eq(ran.risk, null, 'actual console/batch/absent candidate stays allowed: ' + where);
          A.ok(ran.run && ran.run.status === 0, 'native lookup completed: ' + where);
          A.eq(ran.markerKind, cell.expected, 'actual cmd owns this candidate and the guard substitutes no other: ' + where);
        } else {
          A.eq(rig.decide(row.cmd, launch).risk, null, 'actual console/batch/absent candidate stays allowed: ' + where);
        }
      }
    }
  } finally { rig.dispose(); }
} else console.log('Windows native transport not run on this host; resolver fixtures above remain cross-platform.');
plumbing.then(() => A.report('shell-command-resolution.test'), e => { console.error(e); process.exit(1); });
