'use strict';
/* node test/breakaway.test.js — an app the station opens FOR the person is never the station's (sidecar/breakaway.js).

   On Windows the desktop shell holds the station's whole tree in a kill-on-close Job Object, so a station's children
   end with StarNet even when it is killed hard. An app opened for the person on their screen must not: the shell's own
   exe, run as `--starnet-breakaway <hex spec>`, starts it outside the job (its Rust tests prove that with real
   processes). This file proves the sidecar side:
     1. wrap(): with no launcher named (macOS, Linux, `npm start`, a terminal-started station) every call passes through
        untouched; with one, the call becomes the launcher with a spec holding exactly what Node would have run —
        `shell: true` translated the way Node translates it for cmd.exe, windowsHide carried as `hide`.
     2. the ALLOWLIST is wired and nothing else is: desktop.open's opener runs through it; a full-power shell command
        that opens a window (`start`, `explorer`, …) runs through it; an ordinary command does not; a restricted run
        never gets that far (refused). The Resolve launch uses it too (source lock, sliced to the launch). */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const A = require('./_assert.js');
const { makeBreakaway, decodeSpec, FLAG } = require('../sidecar/breakaway.js');

const LAUNCHER = 'C:\\Program Files\\StarNet\\skynet-desktop.exe';
const winEnv = { STARNET_BREAKAWAY_EXE: LAUNCHER, ComSpec: 'C:\\Windows\\system32\\cmd.exe' };

function fakeChild(out, code) {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = () => true;
  setImmediate(() => { c.stdout.emit('data', Buffer.from(out)); c.emit('exit', code); c.emit('close', code); });
  return c;
}

(async () => {
  // ---- 1. wrap ----
  {
    const off = makeBreakaway({ env: { STARNET_BREAKAWAY_EXE: LAUNCHER }, platform: 'darwin' });
    A.eq(off.available, false, 'no launcher off Windows');
    const same = off.wrap('open', ['-a', 'Resolve'], { detached: true });
    A.eq([same.file, same.args, same.options, same.brokered], ['open', ['-a', 'Resolve'], { detached: true }, false], 'a pass-through, untouched');
    const spawnFn = () => 'spawned';
    A.ok(off.spawnVia(spawnFn) === spawnFn, 'spawnVia hands back the very same spawn');
    A.eq(makeBreakaway({ env: {}, platform: 'win32' }).available, false, 'Windows with no launcher named (npm start, the terminal\'s station): a pass-through');
    A.eq(makeBreakaway({ env: { SKYNET_BREAKAWAY_EXE: LAUNCHER }, platform: 'win32' }).exe, LAUNCHER, 'the legacy spelling names it too');

    const on = makeBreakaway({ env: winEnv, platform: 'win32' });
    A.ok(on.available, 'Windows with the launcher named');
    const w = on.wrap('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath 'https://example.com'"], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    A.eq(w.file, LAUNCHER, 'the call becomes the launcher');
    A.eq(w.args[0], FLAG, 'in its breakaway mode');
    A.ok(/^[0-9a-f]+$/.test(w.args[1]), 'the spec is hex (clear of every quoting rule)');
    A.eq(decodeSpec(w.args), { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-Command', "Start-Process -FilePath 'https://example.com'"], verbatim: false, hide: true },
      'the spec is exactly what would have run');
    A.eq(w.options, { encoding: 'utf8', timeout: 15000, windowsHide: true, windowsVerbatimArguments: false }, 'the caller\'s options stay (output, timeout)');
    const sh = on.wrap('start "" "https://example.com" & call echo __M__', undefined, { cwd: 'C:\\w', shell: true, windowsHide: true });
    A.eq(decodeSpec(sh.args), { file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"start "" "https://example.com" & call echo __M__"'], verbatim: true, hide: true },
      'shell: true is translated exactly as Node translates it for cmd.exe (/d /s /c "…", verbatim)');
    A.ok(!('shell' in sh.options) && sh.options.cwd === 'C:\\w', 'the launcher itself runs without a shell, in the same cwd');
    const calls = [];
    const via = on.spawnVia((f, a, o) => { calls.push([f, a, o]); return 'child'; });
    A.eq(via('resolve.exe', [], { detached: true, stdio: 'ignore' }), 'child', 'spawnVia returns the child');
    A.eq(via('echo hi', { shell: true }), 'child', 'and takes spawn(command, options) too');
    A.eq(calls.map(c => [c[0], decodeSpec(c[1]).file]), [[LAUNCHER, 'resolve.exe'], [LAUNCHER, 'C:\\Windows\\system32\\cmd.exe']], 'both went through the launcher');
    A.eq(decodeSpec(['x']), null, 'not a launcher call');
  }

  // ---- 2a. desktop.open's opener runs through it ----
  {
    const { _internals: T } = require('../sidecar/tools/builtin/desktop.js');
    const ran = [];
    const opener = T.makeShellOpener({ platform: 'win32', breakaway: makeBreakaway({ env: winEnv, platform: 'win32' }),
      execFile: (file, args, opts, cb) => { ran.push({ file, args, opts }); setImmediate(() => cb(null, '', '')); } });
    // an app name that exists nowhere: should this wiring ever regress to a real launch, nothing opens on the screen
    let got = null;
    try { got = await opener({ kind: 'app', target: 'starnet-breakaway-test-no-such-app' }); } catch (e) { got = 'threw: ' + e.message; }
    A.eq(got, 'launched', 'the opener still reports its launch');
    A.eq(ran.length, 1, 'one process');
    A.eq(ran[0] && ran[0].file, LAUNCHER, 'desktop.open runs through the breakaway launcher on Windows');
    A.ok(ran[0] && /Start-Process -FilePath 'starnet-breakaway-test-no-such-app'/.test(decodeSpec(ran[0].args).args.join(' ')), 'running the same Start-Process it always did');
    const direct = [];
    const mac = T.makeShellOpener({ platform: 'darwin', breakaway: makeBreakaway({ env: winEnv, platform: 'darwin' }),
      execFile: (file, args, opts, cb) => { direct.push(file); setImmediate(() => cb(null, '', '')); } });
    try { await mac({ kind: 'app', target: 'starnet-breakaway-test-no-such-app' }); } catch (_) {}
    A.eq(direct, ['open'], 'macOS: the plain `open`, untouched');
  }

  // ---- 2b. shell.exec: only a full-power command that opens a window breaks away ----
  {
    const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-breakaway-shell-'));
    try {
      const spawned = [];
      const spawn = (file, a, o) => { spawned.push({ file, args: Array.isArray(a) ? a : null }); return fakeChild('__SK_CWD__' + root + '__SK_EC__0__SK_END__', 0); };
      const tool = makeShellTool({ spawn, fs, pathMod: path, root, platform: 'win32', breakaway: makeBreakaway({ env: winEnv, platform: 'win32' }) }).execTool;
      A.ok(!!tool, 'shell.exec is built');
      const full = { agentId: 'agent', unrestrictedHost: true };
      await tool.run({ cmd: 'start "" "https://example.com"' }, full);
      A.eq(spawned[0] && spawned[0].file, LAUNCHER, 'a full-power `start` (a window for the person) runs through the launcher');
      A.ok(spawned[0] && /start "" "https:\/\/example\.com"/.test(decodeSpec(spawned[0].args).args.join(' ')), 'the same command line, in cmd.exe');
      await tool.run({ cmd: 'echo hi' }, full);
      A.ok(spawned[1] && /echo hi/.test(spawned[1].file) && spawned[1].args === null, 'an ordinary command stays the station\'s (spawned directly)');
      let refused = null;
      try { await tool.run({ cmd: 'start "" "https://example.com"' }, { agentId: 'agent' }); } catch (e) { refused = e; }
      A.ok(refused && /refused \[visible-desktop\]/.test(refused.message), 'a restricted run never opens a window at all');
      A.eq(spawned.length, 2, 'nothing was spawned for the refused one');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  // ---- 2c. the local environment backend honours the flag; the Resolve launch uses the launcher ----
  {
    const env = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'environment.js'), 'utf8');
    const exec = env.slice(env.indexOf('execute: function (opts) {'), env.indexOf('startBackground: function (opts) {'));
    A.ok(/spawn: opts\.breakaway \? require\('\.\/breakaway\.js'\)\.makeBreakaway\(/.test(exec), 'environment.execute runs a breakaway command through the launcher');
    const shell = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'shell.js'), 'utf8');
    const decide = shell.slice(shell.indexOf('const forPerson = '), shell.indexOf('return run.then(function (res) {'));
    A.ok(/^const forPerson = isWin && remoteOwner && \(!environment \|\| environmentBackendId === 'local'\) && !!opensVisibleWindow\(cmd, shellDialect\);/.test(decide),
      'shell.exec decides: Windows, full power, the local backend, and a command that opens a window');
    A.ok(/environment\.execute\(\{[^\n]*ledgerCmd: redact\(cmd\), breakaway: forPerson \}\)/.test(decide) && /runCommand\(\{ spawn: forPerson \? breakaway\.spawnVia\(spawn\) : spawn,/.test(decide),
      'and both run paths carry that decision');
    const resolve = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'resolve.js'), 'utf8');
    const launch = resolve.slice(resolve.indexOf("if (action === 'launch') {"), resolve.indexOf("if (action === 'import_media') {"));
    A.ok(/breakawaySpawn\(app, \[\]/.test(launch) && !/[^y]spawn\(app/.test(launch), 'the Resolve launch runs through the launcher, never a plain spawn');
  }

  A.report('breakaway.test');
})().catch(e => { console.error(e); process.exit(1); });
