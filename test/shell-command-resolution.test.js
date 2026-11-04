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
A.eq(base.handles.size, 0, 'all PE file handles close');

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
    // Native cmd reports a handle-duplication error for this form on this host.
    // Only absence of a second executable is claimed; successful stream routing
    // is proven above by the ordinary 2>&1 / 1>&2 and ordered file cases.
    const lookups = [
      { id: 'raw-console-exe-gui', cmd: 'pick', files: { pick: 'console', 'pick.exe': 'gui' }, actual: 'gui' },
      { id: 'raw-gui-exe-console', cmd: 'pick', files: { pick: 'gui', 'pick.exe': 'console' }, actual: 'console' },
      { id: 'raw-console-com-gui', cmd: 'pick', files: { pick: 'console', 'pick.com': 'gui' }, actual: 'gui' },
      { id: 'raw-gui-com-console', cmd: 'pick', files: { pick: 'gui', 'pick.com': 'console' }, actual: 'console' },
      { id: 'dotted-console-appended-gui', cmd: 'pick.tag', files: { 'pick.tag': 'console', 'pick.tag.exe': 'gui' }, actual: 'console' },
      { id: 'dotted-gui-appended-console', cmd: 'pick.tag', files: { 'pick.tag': 'gui', 'pick.tag.exe': 'console' }, actual: 'gui' },
      { id: 'cwd-batch-path-console', cmd: 'pick', files: { 'pick.cmd': 'batch', 'bin/pick.exe': 'console' }, actual: 'batch' },
      { id: 'cwd-console-path-gui', cmd: 'pick', files: { 'pick.exe': 'console', 'bin/pick.com': 'gui' }, actual: 'console' },
      { id: 'first-path-batch-later-gui', cmd: 'pick', files: { 'bin/pick.cmd': 'batch', 'later/pick.exe': 'gui' }, actual: 'batch' },
      { id: 'custom-pathext', cmd: 'pick', files: { 'pick.com': 'gui', 'pick.exe': 'console' }, actual: 'console', pathext: '.EXE;.COM;.CMD;.BAT' }
    ];
    for (const row of lookups) {
      const cwd = path.join(rig.root, row.id); fs.mkdirSync(cwd);
      for (const [name, kind] of Object.entries(row.files)) {
        const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), { recursive: true });
        if (kind === 'batch') fs.writeFileSync(target, '@echo batch>"%STARNET_SHELL_MARKER%"\r\n');
        else fs.copyFileSync(path.join(rig.root, kind === 'gui' ? 'probe.exe' : 'console-probe.exe'), target);
      }
      const env = Object.assign({}, rig.env, { PATH: [path.join(cwd, 'bin'), path.join(cwd, 'later')].join(';'), PATHEXT: row.pathext || rig.env.PATHEXT });
      // First establish actual native ownership, deliberately executing ONLY
      // our marker images/scripts. Then separately prove guarded dispatch.
      const observed = rig.execute(row.cmd, true, { cwd, env });
      A.eq(observed.run.status, 0, 'native lookup completed: ' + row.id);
      A.eq(observed.markerKind, row.actual, 'actual cmd owns this candidate: ' + row.id);
      const guarded = rig.execute(row.cmd, false, { cwd, env });
      if (row.actual === 'gui') {
        A.ok(guarded.risk, 'the actual GUI candidate is refused: ' + row.id);
        A.eq(guarded.marker, false, 'guard prevents that actual GUI marker');
      } else {
        A.eq(guarded.risk, null, 'actual console/batch candidate stays allowed: ' + row.id);
        A.ok(guarded.run && guarded.run.status === 0, 'allowed actual candidate executes');
        A.eq(guarded.markerKind, row.actual, 'guard does not substitute a different candidate');
      }
    }
  } finally { rig.dispose(); }
} else console.log('Windows native transport not run on this host; resolver fixtures above remain cross-platform.');
A.report('shell-command-resolution.test');
