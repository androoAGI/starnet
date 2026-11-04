'use strict';
// Real Windows transport, harmless PE fixtures. Neither executable opens a
// window or calls an input API: its only effect is writing our allocated marker.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');

function loadShell() {
  const filename = path.resolve(__dirname, '../../sidecar/tools/builtin/shell.js');
  if (!process.env.SHELL_GUARD_CONTROL) return require(filename);
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(process.env.SHELL_GUARD_CONTROL, 'utf8'), filename);
  return m.exports;
}

function windowsRig(api) {
  if (process.platform !== 'win32') throw new Error('Windows transport rig requires Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shell-guard-'));
  const marker = path.join(root, 'owned-marker.txt');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const system = path.join(windows, 'System32');
  const csc = ['Framework64', 'Framework'].map(v => path.join(windows, 'Microsoft.NET', v, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
  if (!csc) throw new Error('The actual Windows proof requires the installed .NET C# compiler');
  const src = path.join(root, 'marker.cs');
  const env = Object.assign({}, process.env, {
    PATH: [root, system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', STARNET_SHELL_MARKER: marker
  });
  // Windows environment names are case-insensitive; avoid two competing PATHs.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key];
  for (const [name, target] of [['probe', 'winexe'], ['console-probe', 'exe']]) {
    const output = target === 'winexe' ? '' : ' Console.Out.WriteLine("owned-stdout"); Console.Error.WriteLine("owned-stderr");';
    fs.writeFileSync(src, 'using System; using System.IO; class Marker { static void Main() { File.WriteAllText(Environment.GetEnvironmentVariable("STARNET_SHELL_MARKER"), "' + (target === 'winexe' ? 'gui' : 'console') + '");' + output + ' } }\n');
    const r = cp.spawnSync(csc, ['/nologo', '/target:' + target, '/out:' + path.join(root, name + '.exe'), src], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (r.error || r.status !== 0) throw new Error('Harmless fixture compilation failed: ' + String(r.error || r.stderr || r.stdout));
  }
  const opts = { cwd: root, exactCwd: true, fs, pathMod: path.win32, isWin: true, dialect: 'cmd', env };
  // The guard's decision alone, for a launch context: no process is started, so a row that only needs a verdict costs nothing.
  function decide(command, launch) {
    launch = Object.assign({ cwd: root, env }, launch);
    return { command, cwd: launch.cwd, escapes: api.escapesWorkspace(command), risk: api.commandSafetyRisk(command, Object.assign({}, opts, { cwd: launch.cwd, env: launch.env })) };
  }
  function execute(command, force, launch) {
    launch = Object.assign({ cwd: root, env }, launch);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const { escapes, risk } = decide(command, launch);
    let run = null;
    if (force || (!escapes && !risk)) {
      const r = cp.spawnSync(api.buildMarkedCmd(command, true, 'guardfixture'), { cwd: launch.cwd, env: launch.env, shell: true, windowsHide: true, encoding: 'utf8', timeout: 10000 });
      run = { status: r.status, error: r.error && r.error.message, stdout: r.stdout, stderr: r.stderr };
    }
    const result = { command, cwd: launch.cwd, escapes, risk, run, marker: fs.existsSync(marker), markerKind: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null };
    console.log(JSON.stringify(result));
    return result;
  }
  return { root, marker, env, opts, execute, decide, dispose() { fs.rmSync(root, { recursive: true, force: true }); } };
}

module.exports = { loadShell, windowsRig };
