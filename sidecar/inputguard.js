/* sidecar/inputguard.js - observe cursor confinement without changing global input state.

   Windows keeps one global cursor clip rectangle. A previous recovery guard called
   ClipCursor(NULL) at Agent OS boot, shutdown, and E-STOP. Windows does not expose a reliable
   owner for that rectangle, so doing so can release another application's legitimate pointer
   lock and interfere with the user.

   observe(reason) is deliberately read-only. It reads GetClipCursor and the virtual-screen
   bounds, reports confinement, and NEVER releases or changes it. A future emergency release
   must live in a trusted native, direct-user-action path that can prove ownership.

     makeInputGuard({ runPs?, platform?, log? })
       -> { observe(reason) -> Promise<{confined,mutated:false,rect}> } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).inputguard = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct SNRECT { public int Left, Top, Right, Bottom; }
public class SNInputGuard {
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out SNRECT rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
"@
$r = New-Object SNRECT
[SNInputGuard]::GetClipCursor([ref]$r) | Out-Null
$vx = [SNInputGuard]::GetSystemMetrics(76); $vy = [SNInputGuard]::GetSystemMetrics(77)
$vw = [SNInputGuard]::GetSystemMetrics(78); $vh = [SNInputGuard]::GetSystemMetrics(79)
$confined = ($r.Left -gt $vx) -or ($r.Top -gt $vy) -or ($r.Right -lt ($vx + $vw)) -or ($r.Bottom -lt ($vy + $vh))
[Console]::Out.Write((@{ confined = [bool]$confined; mutated = $false; rect = @($r.Left, $r.Top, $r.Right, $r.Bottom); screen = @($vx, $vy, $vw, $vh) } | ConvertTo-Json -Compress))
`;

  function defaultRunPs() {
    const CP = require('./child-env.js').guardChildProcess(require('node:child_process'));   // no station secrets in the helper's env
    return () => new Promise((resolve, reject) => {
      const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      CP.execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(new Error(String(err.message || 'input guard probe failed')));
        resolve(String(stdout || '').trim());
      });
    });
  }

  function makeInputGuard(deps) {
    deps = deps || {};
    const platform = deps.platform || (typeof process !== 'undefined' ? process.platform : '');
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const runPs = deps.runPs || (platform === 'win32' ? defaultRunPs() : null);

    async function observe(reason) {
      if (platform !== 'win32' || !runPs) return { confined: false, mutated: false, skipped: true };
      let out;
      try { out = JSON.parse(await runPs()); }
      catch (e) { return { confined: false, mutated: false, error: String((e && e.message) || e) }; }
      const res = { confined: !!(out && out.confined), mutated: false, rect: (out && out.rect) || null };
      if (res.confined) {
        log('[input-guard] cursor is confined to [' + (res.rect || []).join(',') + '] at ' + (reason || 'check') + ' - observed only; global input state left untouched');
      }
      return res;
    }

    return { observe, _internals: { SCRIPT } };
  }

  return { makeInputGuard, _internals: { SCRIPT } };
});
