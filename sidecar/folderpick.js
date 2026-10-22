/* sidecar/folderpick.js — the native OS folder-picker core (Projects rail "browse" button).

   POST /api/projects/pickfolder opens the operating system's own folder chooser on the machine the
   sidecar runs on (which IS the user's machine — local-first) and returns the chosen absolute path.
   The frontend then feeds that path into the EXISTING bless flow (POST /api/projects/bless); this
   module never grants anything — it is strictly a "help the user type a path" convenience, so the
   consent story is unchanged (the bless click stays the consent).

     • INTERACTIVE ONLY — same UNATTENDED RULE as projectbless: an autonomous caller may not pop
       dialogs on the Commander's screen. surface must be 'interactive' or DENY.
     • SINGLE-FLIGHT — one dialog at a time; a second request while one is open is answered
       { ok:false, code:'busy' } instead of stacking dialogs.
     • HONEST DEGRADATION — a platform with no picker (headless linux without zenity, server) returns
       { ok:false, code:'unavailable', reason } so the UI can truthfully fall back to the typed path.
     • CANCEL IS NOT AN ERROR — closing the dialog returns { ok:true, cancelled:true }.

   makeFolderPick({ platform, spawn, timeoutMs })
     platform : process.platform (injected for tests)
     spawn    : (cmd, args, opts) => ChildProcess (node child_process.spawn, injected)
     timeoutMs: dialog patience before we give up and kill it (default 5 minutes — a human is browsing)

   -> { pick }  async pick({ surface }) -> { ok, path?, cancelled?, code?, reason? }   // never throws

   Pure decision helpers (buildCommand / interpret) are exported for headless unit tests, matching the
   projectbless.js pattern. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).folderpick = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The Windows dialog runs in a spawned PowerShell STA process (WinForms needs a single-threaded
  // apartment). The owner form is TopMost so the dialog surfaces above the Agent OS window instead of
  // being born behind it. Output contract: the chosen path on stdout, nothing on cancel, exit 0 both ways.
  const PS_SCRIPT = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
    "Add-Type -AssemblyName System.Drawing | Out-Null;",
    "$owner = New-Object System.Windows.Forms.Form;",
    "$owner.TopMost = $true; $owner.ShowInTaskbar = $false;",
    "$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(0,0);",
    "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$dlg.Description = 'Choose a project folder for Agent OS';",
    "$dlg.ShowNewFolderButton = $true;",
    "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }"
  ].join(' ');

  // FILE mode (recipe launch forms: "point me at a file" should open the real chooser, not ask the Commander to
  // type a path from memory). Same contract as the folder script — the chosen path on stdout, nothing on cancel,
  // exit 0 either way — so interpret() reads both modes identically. Read-only: choosing GRANTS nothing, exactly
  // like the folder picker; the path lands in a form field the user still has to launch.
  const PS_FILE_SCRIPT = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
    "Add-Type -AssemblyName System.Drawing | Out-Null;",
    "$owner = New-Object System.Windows.Forms.Form;",
    "$owner.TopMost = $true; $owner.ShowInTaskbar = $false;",
    "$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(0,0);",
    "$dlg = New-Object System.Windows.Forms.OpenFileDialog;",
    "$dlg.Title = 'Choose a file for Agent OS';",
    "$dlg.Multiselect = $false; $dlg.CheckFileExists = $true;",
    "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }"
  ].join(' ');

  // per-platform command line. null = no native picker known for this platform (honest unavailable).
  // `mode` is 'folder' (default — every pre-existing caller) or 'file'.
  function buildCommand(platform, mode) {
    const file = mode === 'file';
    if (platform === 'win32') {
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', file ? PS_FILE_SCRIPT : PS_SCRIPT] };
    }
    if (platform === 'darwin') {
      // `choose folder` / `choose file` return the POSIX path on stdout; user cancel exits non-zero with -128 on stderr.
      return { cmd: 'osascript', args: ['-e', file
        ? 'POSIX path of (choose file with prompt "Choose a file for Agent OS")'
        : 'POSIX path of (choose folder with prompt "Choose a project folder for Agent OS")'] };
    }
    if (platform === 'linux') {
      // zenity is the least-bad common denominator; cancel exits 1 with empty stdout.
      return file
        ? { cmd: 'zenity', args: ['--file-selection', '--title=Choose a file for Agent OS'] }
        : { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a project folder for Agent OS'] };
    }
    return null;
  }

  // Map a finished dialog process to the honest result. Cancel signatures per platform:
  //   win32  : exit 0, empty stdout          (script prints only on OK)
  //   darwin : exit 1, stderr mentions -128  (osascript "User canceled")
  //   linux  : exit 1, empty stdout          (zenity cancel)
  // Anything else non-zero is a real failure, reported as such.
  // `mode` only shapes the FAILURE noun ("file picker failed" vs "folder picker failed") — a reason line that
  // names the wrong control is exactly the kind of small lie this app doesn't ship. Defaults to folder, so every
  // pre-existing caller (and its tests) reads unchanged.
  function interpret(platform, r, mode) {
    r = r || {};
    const what = mode === 'file' ? 'file' : 'folder';
    const out = String(r.stdout == null ? '' : r.stdout).replace(/[\r\n]+$/, '').trim();
    const code = r.code | 0;
    if (code === 0) {
      if (!out) return { ok: true, cancelled: true };
      // osascript emits a trailing slash on the POSIX path; strip it (but never strip "/" itself).
      const path = (platform === 'darwin' && out.length > 1) ? out.replace(/\/+$/, '') : out;
      return { ok: true, path: path };
    }
    const err = String(r.stderr == null ? '' : r.stderr);
    if ((platform === 'darwin' && err.indexOf('-128') >= 0) || (platform === 'linux' && code === 1 && !out))
      return { ok: true, cancelled: true };
    return { ok: false, code: 'failed', reason: what + ' picker failed (' + (err.trim().slice(0, 200) || ('exit ' + code)) + ')' };
  }

  function makeFolderPick(deps) {
    deps = deps || {};
    const platform = deps.platform || 'unknown';
    const spawn = deps.spawn;
    const timeoutMs = (deps.timeoutMs | 0) > 0 ? (deps.timeoutMs | 0) : 5 * 60 * 1000;
    if (typeof spawn !== 'function') throw new Error('folderpick requires { spawn }');

    let inFlight = false;   // single-flight: one dialog on the Commander's screen at a time

    async function pick(o) {
      o = o || {};
      const mode = o.mode === 'file' ? 'file' : 'folder';   // default keeps every pre-existing caller on folders
      const what = mode === 'file' ? 'file' : 'folder';
      // THE UNATTENDED RULE: only a live user action may pop a dialog on the user's screen.
      if (o.surface !== 'interactive')
        return { ok: false, code: 'autonomous', reason: 'the ' + what + ' picker is a user action — an autonomous run cannot open dialogs.' };
      const built = buildCommand(platform, mode);
      if (!built)
        return { ok: false, code: 'unavailable', reason: 'no native ' + what + ' picker is available on this platform — type the ' + what + ' path instead.' };
      if (inFlight)
        return { ok: false, code: 'busy', reason: 'a ' + what + ' picker is already open — finish or cancel it first.' };
      inFlight = true;
      try {
        return await new Promise((resolve) => {
          let done = false;
          const finish = (r) => { if (!done) { done = true; resolve(r); } };
          let child;
          try { child = spawn(built.cmd, built.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
          catch (e) { return finish({ ok: false, code: 'unavailable', reason: 'could not launch the folder picker: ' + (e && e.message || e) }); }
          let stdout = '', stderr = '';
          if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
          if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
          const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: true, cancelled: true }); }, timeoutMs);
          child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: 'unavailable', reason: 'could not launch the ' + what + ' picker: ' + (e && e.message || e) }); });
          child.on('close', (code) => { clearTimeout(timer); finish(interpret(platform, { code: code, stdout: stdout, stderr: stderr }, mode)); });
        });
      } finally {
        inFlight = false;
      }
    }

    return { pick };
  }

  return { makeFolderPick, buildCommand, interpret };
});
