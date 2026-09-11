'use strict';
const A = require('./_assert.js');
const { makeWin32DesktopDriver, powershellPath } = require('../sidecar/tools/builtin/win32desktop.js');
const CP = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Execute the actual PowerShell dispatch, replacing only native screen/input calls.
// Mocking execFile's response cannot catch PowerShell command/alias precedence bugs.
async function checkNativeDispatch() {
  if (process.platform !== 'win32') return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-mouse-dispatch-'));
  const nativeStub = `Add-Type @'
using System;
public static class StarNetNative {
  public static bool SetCursorPos(int x, int y) { Console.Error.WriteLine("cursor " + x + "," + y); return true; }
  public static void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra) { Console.Error.WriteLine("mouse " + flags); }
}
'@`;
  const traces = [];
  const driver = makeWin32DesktopDriver({ execFile: (exe, args, opts, cb) => {
    const program = args[args.length - 1].replace(/Add-Type @'[\s\S]*?'@/, nativeStub);
    if (program === args[args.length - 1] || program.includes('DllImport(')) {
      return cb(new Error('native input stub was not installed; refusing to execute regression'));
    }
    CP.execFile(exe, [...args.slice(0, -1), program], { ...opts, cwd }, (err, stdout, stderr) => {
      traces.push(String(stderr).trim().split(/\r?\n/).filter(Boolean));
      cb(err, stdout, stderr);
    });
  } });
  try {
    for (const [action, expected] of [
      [{ action: 'move', x: 306, y: 994 }, ['cursor 306,994']],
      [{ action: 'click', x: 306, y: 994 }, ['cursor 306,994', 'mouse 2', 'mouse 4']],
      [{ action: 'double_click', x: 306, y: 994 }, ['cursor 306,994', 'mouse 2', 'mouse 4', 'mouse 2', 'mouse 4']],
      [{ action: 'drag', x: 306, y: 994, dx: -20, dy: 15 }, ['cursor 306,994', 'mouse 2', 'cursor 286,1009', 'mouse 4']],
      [{ action: 'move', x: -306, y: 0 }, ['cursor -306,0']]
    ]) {
      A.eq(await driver.perform(action), 'performed ' + action.action, action.action + ' executes in real PowerShell');
      A.eq(traces.at(-1), expected, action.action + ' dispatches exact native coordinates and mouse order');
    }
    A.eq(fs.readdirSync(cwd), [], 'movement actions create no filesystem artifacts');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

(async () => {
  const seen = [];
  const driver = makeWin32DesktopDriver({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFile: (exe, args, opts, cb) => {
      seen.push({ exe, args, opts });
      const request = JSON.parse(opts.env.STARNET_REMOTE_DESKTOP_REQUEST);
      if (request.kind === 'capture') return cb(null, JSON.stringify({ width: 2, height: 1, data: 'iVBORw0KGgo=' }), '');
      if (request.kind === 'foreground') return cb(null, JSON.stringify({ title: 'Notepad', process: 'notepad' }), '');
      cb(null, JSON.stringify({ ok: true, action: request.action.action }), '');
    }
  });
  A.ok(driver, 'Windows creates the native driver');
  A.eq(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'native driver resolves the system PowerShell path');
  A.eq(await driver.perform({ action: 'type', text: "x'; Remove-Item C:\\*" }), 'performed type', 'action data is treated as data by the native bridge');
  A.eq(JSON.parse(seen[0].opts.env.STARNET_REMOTE_DESKTOP_REQUEST).action.text, "x'; Remove-Item C:\\*", 'untrusted action text travels only inside JSON');
  A.ok(!seen[0].args.join(' ').includes("Remove-Item"), 'action text is never interpolated into the PowerShell program');
  A.eq(await driver.foreground(), { title: 'Notepad', process: 'notepad' }, 'native foreground probe is returned as structured data');
  A.eq((await driver.capture()).width, 2, 'native capture returns image metadata');
  A.eq(makeWin32DesktopDriver({ platform: 'linux' }), null, 'non-Windows host has no native driver');
  await checkNativeDispatch();
  A.report('win32desktop.test');
})().catch(e => { console.error(e); process.exit(1); });
