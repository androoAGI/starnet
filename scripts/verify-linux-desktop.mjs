#!/usr/bin/env node
// Run inside dbus-run-session + Xvfb with a window manager. Accepts an installed
// binary or an extracted AppImage's AppRun. All launches share one disposable XDG profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'linux' || !process.argv[2]) {
  throw new Error('Usage: node scripts/verify-linux-desktop.mjs /absolute/path/to/app');
}
const executable = resolve(process.argv[2]);
const profile = mkdtempSync(join(tmpdir(), 'starnet-linux-smoke-'));
const data = join(profile, 'data', 'ai.skynet.harness');
const workspace = join(data, 'workspaces');
mkdirSync(workspace, { recursive: true });
// Suppress legacy migration so a local smoke never reads the user's real station.
writeFileSync(join(workspace, '.migrated'), 'isolated Linux smoke\n');
const sentinel = join(workspace, 'linux-smoke-sentinel.txt');
writeFileSync(sentinel, 'preserve across relaunch\n');
const env = { ...process.env, XDG_DATA_HOME: join(profile, 'data'),
  XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache') };
const logPath = join(data, 'startup.log');
let shell;
let sidecarPid;
let output = '';
const log = () => { try { return readFileSync(logPath, 'utf8'); } catch { return ''; } };
const running = pid => {
  try {
    // A reparented zombie has exited; its init/subreaper owns waitpid.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
};
async function until(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function launch(checkDependencies = false) {
  const offset = log().length;
  shell = spawn(executable, [], { env, cwd: profile, stdio: ['ignore', 'pipe', 'pipe'] });
  shell.stdout.on('data', chunk => { output += chunk; });
  shell.stderr.on('data', chunk => { output += chunk; });
  shell.on('error', error => { output += error.message; });
  let port;
  await until('sidecar health and loaded WebKit document', async () => {
    if (shell.exitCode !== null || shell.signalCode) throw new Error('Desktop exited during startup');
    const recent = log().slice(offset);
    const match = recent.match(/spawn_sidecar pid=(\d+) port=(\d+) listening=true/);
    if (!match || !recent.includes('webview-startup: initial document loaded')) return false;
    sidecarPid = Number(match[1]); port = Number(match[2]);
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`,
      { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  });
  const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(shell.pid),
    '--name', '^StarNet$'], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(windows.length && /^\d+$/.test(windows[0]), 'visible native window');
  const image = readlinkSync(`/proc/${sidecarPid}/exe`);
  const shellImage = readlinkSync(`/proc/${shell.pid}/exe`);
  assert.equal(image, join(dirname(shellImage), 'starnet-node'), 'uses this package\'s bundled runtime');
  const root = readlinkSync(`/proc/${sidecarPid}/cwd`);
  assert.equal(root, join(dirname(dirname(shellImage)), 'lib', 'StarNet'),
    'uses this package\'s resources, never another installed copy or the source tree');
  // Exercise the shipped dependency closure using the shipped Node, from resources.
  if (checkDependencies) execFileSync(image, ['-e', `
    (async () => {
      const sharp = require('sharp');
      await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
      const asr = require('onnxruntime-node');
      const tts = require('node:module').createRequire(require.resolve('kokoro-js'))('onnxruntime-node');
      // One-float Identity graph, ONNX IR 8 / opset 13; no model download.
      const model = Buffer.from('CAg6PgoQCgF4EgF5IghJZGVudGl0eRIIaWRlbnRpdHlaDwoBeBIKCggIARIECgIIAWIPCgF5EgoKCAgBEgQKAggBQgIQDQ==', 'base64');
      for (const ort of [asr, tts]) {
        const session = await ort.InferenceSession.create(model, {executionProviders:['cpu']});
        try {
          const result = await session.run({x: new ort.Tensor('float32', Float32Array.of(42), [1])});
          if (result.y.data[0] !== 42) throw new Error('ONNX identity inference failed');
        } finally { await session.release(); }
      }
      const started = Date.now();
      const stopped = await require('./sidecar/tools/builtin/shell.js').runCommand({
        spawn: require('node:child_process').spawn, cmd: 'sleep 5', cwd: process.cwd(),
        timeoutMs: 100, maxBytes: 1024, isWin: false
      });
      if (!stopped.timedOut || Date.now() - started >= 4500) throw new Error('Shell timeout left a child running');
      const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf linux-pty-ok'], {cols:80,rows:24});
      let output = '';
      const timeout = setTimeout(() => { pty.kill(); process.exit(1); }, 5000);
      pty.onData(data => { output += data; });
      pty.onExit(({exitCode}) => { clearTimeout(timeout); process.exit(exitCode === 0 && output.includes('linux-pty-ok') ? 0 : 1); });
    })().catch(error => { console.error(error); process.exit(1); });
  `], { cwd: root, env, timeout: 15000, stdio: 'pipe' });
  return windows[0];
}
try {
  // A private D-Bus session and disposable, unlocked keyring avoid touching the
  // user's login keyring or hanging on an invisible first-use password prompt.
  const busPid = execFileSync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetConnectionUnixProcessID',
    'string:org.freedesktop.DBus'], { encoding: 'utf8' }).match(/uint32 (\d+)/)?.[1];
  assert.ok(busPid, 'run this smoke inside a private dbus-run-session');
  const busArgs = readFileSync(`/proc/${busPid}/cmdline`, 'utf8');
  assert.ok(busArgs.includes('--nofork') && busArgs.includes('--print-address'),
    'refusing to use the login D-Bus session; use dbus-run-session');
  execFileSync('dbus-update-activation-environment', ['DISPLAY', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'], { env });
  execFileSync('gnome-keyring-daemon', ['--unlock', '--components=secrets',
    '--control-directory', join(profile, 'keyring')], { env, input: 'starnet-disposable-smoke\n', timeout: 10000 });
  let window = await launch(true);
  // Real WM_DELETE_WINDOW exercises the native close handler and graceful drain.
  execFileSync('wmctrl', ['-ic', `0x${Number(window).toString(16)}`]);
  await until('idle window close drains shell and sidecar', () => !running(shell.pid) && !running(sidecarPid));
  await launch();
  shell.kill('SIGKILL');
  await until('shell crash drains orphan sidecar', () => !running(sidecarPid), 15000);
  window = await launch();
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve across relaunch\n');
  execFileSync('wmctrl', ['-ic', `0x${Number(window).toString(16)}`]);
  await until('relaunch closes cleanly', () => !running(shell.pid) && !running(sidecarPid));
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
    executable, checks: ['WebKit document loaded', 'visible window', 'sidecar health',
      'bundled Node', 'Sharp/PTY and both ONNX CPU ABIs', 'shell timeout', 'idle close', 'crash cleanup', 'relaunch preserves data'],
    result: 'PASS' }, null, 2));
} catch (error) {
  console.error(output, log());
  throw error;
} finally {
  if (shell && running(shell.pid)) shell.kill('SIGKILL');
  if (sidecarPid && running(sidecarPid)) { try { process.kill(sidecarPid, 'SIGTERM'); } catch {} }
  await delay(1500);
  // xdg-document-portal may have mounted its private FUSE view below this profile.
  try { execFileSync('fusermount3', ['-u', join(env.XDG_CACHE_HOME, 'doc')], { stdio: 'ignore' }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); }
  catch (error) {
    if (error.code !== 'EBUSY') throw error;
    console.error(`Temporary profile still mounted by session portal: ${profile}`);
  }
}
