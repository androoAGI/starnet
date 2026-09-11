/* sidecar/tools/builtin/win32desktop.js -- native Windows driver behind the remote-owner lease.

   This is intentionally separate from computer.js: the generic tool owns validation and the run-context
   boundary, while this module only translates an already-authorized action to the interactive Windows session.
   The PowerShell program is constant; action data travels as JSON in an environment variable, never as a
   command fragment. */
'use strict';

const CP = require('node:child_process');

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StarNetNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
}
'@
function Emit($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 4)) }
function Mouse($flag, $data) { [StarNetNative]::mouse_event([uint32]$flag, 0, 0, [uint32]$data, [UIntPtr]::Zero) }
# Avoid Move: PowerShell resolves its built-in Move-Item alias before a same-named function.
function Set-StarNetCursorPosition($x, $y) { if (-not [StarNetNative]::SetCursorPos([int]$x, [int]$y)) { throw 'SetCursorPos failed' } }
function UnicodeText([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    $down = New-Object StarNetNative+INPUT; $down.type = 1; $down.U.ki.wScan = [uint16][char]$ch; $down.U.ki.dwFlags = 0x0004
    $up = New-Object StarNetNative+INPUT; $up.type = 1; $up.U.ki.wScan = [uint16][char]$ch; $up.U.ki.dwFlags = 0x0004 -bor 0x0002
    if ([StarNetNative]::SendInput(2, @($down, $up), [Runtime.InteropServices.Marshal]::SizeOf([type][StarNetNative+INPUT])) -ne 2) { throw 'SendInput failed' }
  }
}
function SendKey([string]$key) {
  $map = @{ 'enter' = '{ENTER}'; 'tab' = '{TAB}'; 'escape' = '{ESC}'; 'esc' = '{ESC}'; 'space' = ' '; 'backspace' = '{BACKSPACE}'; 'delete' = '{DELETE}'; 'del' = '{DELETE}'; 'up' = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'; 'home' = '{HOME}'; 'end' = '{END}'; 'pageup' = '{PGUP}'; 'pagedown' = '{PGDN}' }
  $k = $key.Trim().ToLowerInvariant(); $send = $map[$k]; if (-not $send) { $send = '{' + $key.Trim().ToUpperInvariant() + '}' }
  [System.Windows.Forms.SendKeys]::SendWait($send)
}
function SendHotkey($keys) {
  $prefix = ''; $final = ''
  foreach ($key in @($keys)) {
    $k = ([string]$key).Trim().ToLowerInvariant()
    if ($k -eq 'ctrl' -or $k -eq 'control') { $prefix += '^' }
    elseif ($k -eq 'alt') { $prefix += '%' }
    elseif ($k -eq 'shift') { $prefix += '+' }
    else { $final = $k }
  }
  if (-not $final) { throw 'hotkey needs a non-modifier key' }
  $map = @{ 'enter' = '{ENTER}'; 'tab' = '{TAB}'; 'escape' = '{ESC}'; 'esc' = '{ESC}'; 'space' = ' '; 'backspace' = '{BACKSPACE}'; 'delete' = '{DELETE}'; 'del' = '{DELETE}'; 'up' = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'; 'home' = '{HOME}'; 'end' = '{END}' }
  $tail = $map[$final]; if (-not $tail) { $tail = $final.ToUpperInvariant() }
  [System.Windows.Forms.SendKeys]::SendWait($prefix + $tail)
}
try {
  $request = $env:STARNET_REMOTE_DESKTOP_REQUEST | ConvertFrom-Json
  if ($request.kind -eq 'foreground') {
    $h = [StarNetNative]::GetForegroundWindow(); $title = New-Object Text.StringBuilder 1024; [void][StarNetNative]::GetWindowText($h, $title, $title.Capacity)
    [uint32]$windowPid = 0; [void][StarNetNative]::GetWindowThreadProcessId($h, [ref]$windowPid); $proc = ''; try { $proc = (Get-Process -Id $windowPid -ErrorAction Stop).ProcessName } catch {}
    Emit @{ title = $title.ToString(); process = $proc }
  } elseif ($request.kind -eq 'capture') {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object Drawing.Bitmap $vs.Width, $vs.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
    Emit @{ width = $vs.Width; height = $vs.Height; data = [Convert]::ToBase64String($ms.ToArray()) }; $ms.Dispose()
  } elseif ($request.kind -eq 'perform') {
    $a = $request.action; $kind = [string]$a.action
    if ($kind -eq 'move') { Set-StarNetCursorPosition $a.x $a.y }
    elseif ($kind -eq 'click' -or $kind -eq 'double_click') { Set-StarNetCursorPosition $a.x $a.y; $count = if ($kind -eq 'double_click') { 2 } else { 1 }; for ($i = 0; $i -lt $count; $i++) { Mouse 0x0002 0; Mouse 0x0004 0 } }
    elseif ($kind -eq 'drag') { Set-StarNetCursorPosition $a.x $a.y; Mouse 0x0002 0; Start-Sleep -Milliseconds 30; Set-StarNetCursorPosition ([int]$a.x + [int]$a.dx) ([int]$a.y + [int]$a.dy); Mouse 0x0004 0 }
    elseif ($kind -eq 'scroll') { if ($a.dy) { Mouse 0x0800 ([int]$a.dy) }; if ($a.dx) { Mouse 0x1000 ([int]$a.dx) } }
    elseif ($kind -eq 'type') { UnicodeText ([string]$a.text) }
    elseif ($kind -eq 'key') { SendKey ([string]$a.key) }
    elseif ($kind -eq 'hotkey') { SendHotkey $a.keys }
    elseif ($kind -eq 'wait') { Start-Sleep -Milliseconds ([Math]::Min(10000, [Math]::Max(0, [int]$a.durationMs))) }
    elseif ($kind -ne 'screenshot') { throw ('unsupported action: ' + $kind) }
    Emit @{ ok = $true; action = $kind }
  } else { throw 'unknown desktop request' }
} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }
`;

function powershellPath(env) {
  const root = String((env || process.env).SystemRoot || '').trim();
  return root ? root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
}

function makeWin32DesktopDriver(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const execFile = opts.execFile || CP.execFile;
  const envBase = opts.env || process.env;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  function invoke(payload) {
    return new Promise((resolve, reject) => {
      const env = Object.assign({}, envBase, { STARNET_REMOTE_DESKTOP_REQUEST: JSON.stringify(payload) });
      execFile(powershellPath(envBase), ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], {
        windowsHide: true, timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024, env
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || 'native desktop command failed').trim()));
        try { resolve(JSON.parse(String(stdout || ''))); }
        catch (_) { reject(new Error('native desktop command returned no valid result')); }
      });
    });
  }
  return {
    perform: async action => { const out = await invoke({ kind: 'perform', action: action || {} }); return out && out.action ? 'performed ' + out.action : 'performed'; },
    capture: () => invoke({ kind: 'capture' }),
    foreground: () => invoke({ kind: 'foreground' }),
    _invoke: invoke
  };
}

module.exports = { makeWin32DesktopDriver, powershellPath, POWERSHELL };
