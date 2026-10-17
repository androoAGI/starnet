/* node test/shell-session.test.js — persistent shell session cwd (H2.1).
   Proves: a `cd` carries over to the next command (state persists), an out-of-jail cwd is NOT persisted (clamp),
   the REAL exit code is recovered from the marker (the appended echo can't mask it), and `cd ..` past the jail
   root is still refused. Uses an INJECTED fake spawn (no real shell) + the real `path` module, so it is
   platform-stable and deterministic. Also unit-tests the pure marker helpers. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const shell = require('../sidecar/tools/builtin/shell.js');
const { makeShellTool, buildMarkedCmd, parseMarker, withinJail, normalizeWinCwd, resolveShellCwd } = shell;

// a fake spawn: records each call's cwd, and on close emits stdout = out + the marker for a configured cwd/ec.
function makeFake() {
  const calls = [];
  let next = { reportCwd: '', ec: 0, out: 'ok' };
  function spawn(cmd, opts) {
    calls.push({ cmd: cmd, cwd: opts && opts.cwd });
    const cfg = next; next = { reportCwd: '', ec: 0, out: 'ok' };
    let dataCb = null;
    const child = {
      pid: 1, kill: function () {},
      stdout: { on: function (ev, fn) { if (ev === 'data') dataCb = fn; } },
      stderr: { on: function () {} },
      on: function (ev, fn) {
        if (ev === 'close') setTimeout(function () {
          const marker = '\n__SK_CWD__' + cfg.reportCwd + '__SK_EC__' + cfg.ec + '__SK_END__';
          if (dataCb) dataCb(Buffer.from(String(cfg.out) + marker));
          fn(0);   // the marked shell itself exits 0; the REAL code is inside the marker
        }, 0);
      }
    };
    return child;
  }
  spawn.calls = calls;
  spawn.setNext = function (c) { next = Object.assign({ reportCwd: '', ec: 0, out: 'ok' }, c); };
  return spawn;
}

(async () => {
  // ---- pure helpers ----
  A.ok(buildMarkedCmd('ls', false).indexOf('pwd') >= 0, 'posix marker appends a pwd printf');
  // The caret form is the fix (h1 F5): plain %CD%/%ERRORLEVEL% are expanded when cmd.exe PARSES the line, i.e. BEFORE
  // the command runs, so they reported the pre-command cwd and exit 0. `call` re-expands the caret form at run time.
  A.ok(buildMarkedCmd('dir', true).indexOf('call echo __SK_CWD__%^CD%__SK_EC__%^ERRORLEVEL%__SK_END__') >= 0, 'win marker appends the run-time (caret) %^CD% + %^ERRORLEVEL%');
  A.ok(!/%CD%|%ERRORLEVEL%/.test(buildMarkedCmd('dir', true)), 'win marker never uses the parse-time %CD%/%ERRORLEVEL% forms');
  {
    const pm = parseMarker('hello world\n__SK_CWD__/ws/a/sub__SK_EC__3__SK_END__');
    A.eq(pm.cwd, '/ws/a/sub', 'parseMarker extracts cwd');
    A.eq(pm.ec, 3, 'parseMarker extracts the real exit code');
    A.eq(pm.cleanOut, 'hello world', 'parseMarker strips the marker (and the newline we added) from the output');
    A.eq(parseMarker('no marker here').cwd, null, 'no marker -> null cwd, output untouched');
  }
  {
    const jail = path.join('root', 'a');
    A.ok(withinJail(path, path.join(jail, 'sub'), jail), 'a subdir is in-jail');
    A.ok(withinJail(path, jail, jail), 'the jail root itself is in-jail');
    A.ok(!withinJail(path, path.resolve(path.sep + 'etc'), jail), 'an absolute outside path is out-of-jail');
  }
  {
    const W = path.win32;
    const root = 'C:\\Users\\andro\\AppData\\Local\\StarNet\\workspaces';
    const jail = W.join(root, 'agent');
    const ext = 'C:\\Users\\andro\\Desktop\\GALAGA';
    const fakeFs = { existsSync: function () { return true; }, statSync: function () { return { isDirectory: function () { return true; } }; } };
    A.eq(normalizeWinCwd(W, '/c/Users/andro/Desktop/GALAGA', true), ext, 'win cwd normalizes /c/Users to C:\\Users');
    A.eq(resolveShellCwd({ pathMod: W, fs: fakeFs, requested: '/c/Users/andro/Desktop/GALAGA', current: jail, jailRoot: jail, root: root, isWin: true, allowExternal: true }), ext, 'external cwd can be resolved when local shell access allows it');
    let denied = false;
    try { resolveShellCwd({ pathMod: W, fs: fakeFs, requested: W.join(root, 'other'), current: jail, jailRoot: jail, root: root, isWin: true, allowExternal: true }); } catch (_) { denied = true; }
    A.ok(denied, 'cwd cannot target another StarNet workspace sibling');
  }

  // ---- integration via the fake spawn ----
  const ROOT = path.join('shelltest-root');
  const fs = { mkdirSync: function () {}, existsSync: function () { return true; } };
  const spawn = makeFake();
  const { execTool } = makeShellTool({ spawn: spawn, fs: fs, pathMod: path, root: ROOT, clock: { now: function () { return 0; } }, platform: 'linux' });
  A.ok(execTool.description.indexOf('POSIX shell') >= 0, 'linux shell description instructs POSIX shell (/bin/sh)');
  A.ok(execTool.description.indexOf('powershell') < 0, 'linux shell description does not instruct PowerShell');
  const winShell = makeShellTool({ spawn: spawn, fs: fs, pathMod: path, root: ROOT, clock: { now: function () { return 0; } }, platform: 'win32' }).execTool;
  A.ok(winShell.description.indexOf('cmd.exe') >= 0 && winShell.description.indexOf('powershell') >= 0, 'win32 shell description instructs cmd.exe and PowerShell wrapping');
  const ctx = { agentId: 'a' };
  const jail = path.join(ROOT, 'a');
  const sub = path.join(jail, 'sub');

  // Step 1: `cd sub` reports cwd = jail/sub -> persisted
  spawn.setNext({ reportCwd: sub, ec: 0, out: 'changed dir' });
  let r = await execTool.run({ cmd: 'cd sub' }, ctx);
  A.eq(spawn.calls[0].cwd, jail, 'first command runs in the jail root (no session yet)');
  A.ok(r.content.indexOf('__SK_CWD__') < 0, 'the marker is stripped from the shown output');

  // Step 2: next command runs in the PERSISTED cwd (cd carried over)
  spawn.setNext({ reportCwd: sub, ec: 0, out: 'in sub' });
  r = await execTool.run({ cmd: 'pwd' }, ctx);
  A.eq(spawn.calls[1].cwd, sub, 'second command runs in the persisted cwd — `cd` carried over across calls');

  // Step 3: a command whose marker reports an OUT-OF-JAIL cwd must NOT be persisted (clamp)
  spawn.setNext({ reportCwd: path.resolve(path.sep + 'etc'), ec: 0, out: 'escaped' });
  await execTool.run({ cmd: 'cd /etc' }, ctx);
  spawn.setNext({ reportCwd: sub, ec: 0 });
  await execTool.run({ cmd: 'pwd' }, ctx);
  A.eq(spawn.calls[3].cwd, sub, 'an out-of-jail cwd is refused for persistence (clamp); next call stays in jail');

  // Step 4: the REAL exit code (from the marker) is reported, not the appended echo's 0
  spawn.setNext({ reportCwd: sub, ec: 7, out: 'boom' });
  r = await execTool.run({ cmd: 'false' }, ctx);
  A.ok(/exit 7/.test(r.content), 'the real exit code is recovered from the marker (not masked by the appended echo)');
  A.ok(/exit 7/.test(r.summary), 'the summary also reports the real exit code');

  // Step 5: `cd ..` past the jail root is still refused outright
  let threw = false;
  try { await execTool.run({ cmd: 'cd ..' }, ctx); } catch (e) { threw = /refused/.test(String(e.message)); }
  A.ok(threw, 'cd .. past the jail root is refused (escapesWorkspace)');

  // Step 6: a Windows local environment can run from a user-named host folder via structured cwd, not `cd /c/...`.
  {
    const W = path.win32;
    const root = 'C:\\Users\\andro\\AppData\\Local\\StarNet\\workspaces';
    const jailWin = W.join(root, 'agent');
    const ext = 'C:\\Users\\andro\\Desktop\\GALAGA';
    const calls = [];
    const fakeEnv = {
      backendId: 'local',
      ensureWorkspace: function () { return jailWin; },
      getCwd: function () { return jailWin; },
      rememberCwd: function () {},
      execute: function (o) {
        calls.push(o);
        return Promise.resolve({ out: 'ok\n__SK_CWD__' + ext + '__SK_EC__0__SK_END__', exitCode: 0, ms: 0, truncated: false, timedOut: false, aborted: false });
      }
    };
    const fakeFs = { existsSync: function () { return true; }, statSync: function () { return { isDirectory: function () { return true; } }; } };
    const tool = makeShellTool({ environment: fakeEnv, fs: fakeFs, pathMod: W, root: root, clock: { now: function () { return 0; } }, platform: 'win32' }).execTool;
    await tool.run({ cmd: 'dir', cwd: '/c/Users/andro/Desktop/GALAGA' }, { agentId: 'agent' });
    A.eq(calls[0].cwd, ext, 'structured cwd starts the command in the user-named Desktop folder');
    await tool.run({ cmd: 'dir' }, { agentId: 'agent' });
    A.eq(calls[1].cwd, ext, 'external cwd persists across later local shell calls');
  }

  // Step 7: a project-scoped session starts relative shell work at its blessed root, with cwd state isolated
  // from the same agent's ordinary private-workspace shell session.
  {
    const W = path.win32;
    const root = 'C:\\Users\\andro\\AppData\\Local\\StarNet\\workspaces';
    const jailWin = W.join(root, 'agent');
    const project = 'C:\\Users\\andro\\Desktop\\PROJECT';
    const projectSub = W.join(project, 'sub');
    const calls = [];
    let reported = project;
    const fakeEnv = {
      backendId: 'local',
      ensureWorkspace: function () { return jailWin; },
      getCwd: function () { return jailWin; },
      rememberCwd: function () {},
      execute: function (o) {
        calls.push(o);
        return Promise.resolve({ out: 'ok\n__SK_CWD__' + reported + '__SK_EC__0__SK_END__', exitCode: 0, ms: 0, truncated: false, timedOut: false, aborted: false });
      }
    };
    const fakeFs = { existsSync: function () { return true; }, statSync: function () { return { isDirectory: function () { return true; } }; } };
    const tool = makeShellTool({ environment: fakeEnv, fs: fakeFs, pathMod: W, root: root, clock: { now: function () { return 0; } }, platform: 'win32' }).execTool;
    const projectCtx = { agentId: 'agent', runId: 'project-run', projectRoot: project };
    await tool.run({ cmd: 'dir' }, projectCtx);
    A.eq(calls[0].cwd, project, 'project-scoped shell.exec defaults to projectRoot');
    reported = projectSub;
    await tool.run({ cmd: 'dir', cwd: 'sub' }, projectCtx);
    A.eq(calls[1].cwd, projectSub, 'relative structured cwd resolves from projectRoot');
    await tool.run({ cmd: 'dir' }, projectCtx);
    A.eq(calls[2].cwd, projectSub, 'project cwd persists within the same run scope');
    reported = jailWin;
    await tool.run({ cmd: 'dir' }, { agentId: 'agent', runId: 'ordinary-run' });
    A.eq(calls[3].cwd, jailWin, 'an unscoped run does not inherit the project session cwd');
  }

  // Step 8: Full Power bypasses the generic machine-command and host-cwd floors. The injected environment
  // records the dangerous-shaped command but never executes it, so this proves policy without mutating the host.
  {
    const W = path.win32;
    const root = 'C:\\Users\\andro\\AppData\\Local\\StarNet\\workspaces';
    const jailWin = W.join(root, 'agent');
    const hostDir = 'C:\\Windows';
    const calls = [];
    const fakeEnv = {
      backendId: 'local',
      ensureWorkspace: function () { return jailWin; },
      getCwd: function () { return jailWin; },
      rememberCwd: function () {},
      execute: function (o) {
        calls.push(o);
        return Promise.resolve({ out: 'simulated\n__SK_CWD__' + hostDir + '__SK_EC__0__SK_END__', exitCode: 0, ms: 0, truncated: false, timedOut: false, aborted: false });
      }
    };
    const fakeFs = { existsSync: function () { return true; }, statSync: function () { return { isDirectory: function () { return true; } }; } };
    const tool = makeShellTool({ environment: fakeEnv, fs: fakeFs, pathMod: W, root: root, clock: { now: function () { return 0; } }, platform: 'win32' }).execTool;
    let restricted = false;
    try { await tool.run({ cmd: 'shutdown /r /t 0', cwd: hostDir }, { agentId: 'agent' }); } catch (e) { restricted = /refused/.test(String(e.message)); }
    A.ok(restricted && calls.length === 0, 'restricted mode still stops a machine-state command before execution');
    await tool.run({ cmd: 'shutdown /r /t 0', cwd: hostDir }, { agentId: 'agent', unrestrictedHost: true, inputMode: 'full-power' });
    A.eq(calls.length, 1, 'Full Power dispatches the arbitrary host command through the general executor');
    A.eq(calls[0].cwd, hostDir, 'Full Power executes from an arbitrary host directory');
  }

  A.report('shell-session.test');
})().catch(function (e) { console.error(e); process.exit(1); });
