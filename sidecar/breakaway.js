/* sidecar/breakaway.js — open an app FOR the person so that it is never the station's.

   On Windows the desktop shell holds the station's whole process tree in a kill-on-close Job Object
   (src-tauri/src/process_job.rs): a station's children end with the station, even when StarNet is killed hard. That
   is right for the station's own work (the station browser, MCP and language servers, shells, dev servers) and WRONG
   for an app the station opened for the person on their screen — a browser, Resolve, Notepad: closing StarNet must
   never close it, let alone lose its unsaved work. Node cannot ask Windows for that (libuv has no
   CREATE_BREAKAWAY_FROM_JOB), so the shell offers a launcher: its own exe run as
   `--starnet-breakaway <hex spec>` starts the program outside the job, passes its output through, and exits with
   its exit code. The shell names itself in STARNET_BREAKAWAY_EXE (both spellings) only on Windows; with no launcher
   named (macOS, Linux, `npm start`, a terminal-started station, an older shell) every call here is a pass-through.

   THE ALLOWLIST (who calls this, and nobody else): desktop.open (an URL or app on the person's screen), the Resolve
   launch, and a full-power shell command that opens a window (shell.js opensVisibleWindow: `start`, `explorer`,
   rundll32 url.dll, a headed browser). Everything else stays the station's.

   makeBreakaway({ env?, platform? }) -> {
     available: bool,
     wrap(file, args, options) -> { file, args, options, brokered }   the spawn call to make instead (spawn semantics,
                                    including `shell: true` the way Node itself translates it for cmd.exe)
     spawnVia(spawn) -> spawn-like                                    the same, as a drop-in for spawn(file, args?, options)
   } */
'use strict';

const FLAG = '--starnet-breakaway';

function launcherExe(env) {
  const e = env || {};
  return String(e.STARNET_BREAKAWAY_EXE || e.SKYNET_BREAKAWAY_EXE || '').trim();
}

function makeBreakaway(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const platform = String(d.platform || process.platform);
  const exe = platform === 'win32' ? launcherExe(env) : '';

  function wrap(file, args, options) {
    const opts = Object.assign({}, options || {});
    const list = Array.isArray(args) ? args.map(String) : [];
    if (!exe) return { file, args: Array.isArray(args) ? args : undefined, options: options, brokered: false };
    let program = String(file), argv = list, verbatim = !!opts.windowsVerbatimArguments;
    if (opts.shell) {
      // exactly Node's own translation (child_process normalizeSpawnArguments): the command line goes to the shell
      const command = [program].concat(list).join(' ');
      const shell = typeof opts.shell === 'string' ? opts.shell : (env.ComSpec || env.comspec || env.COMSPEC || 'cmd.exe');
      program = shell;
      if (/^(?:.*\\)?cmd(?:\.exe)?$/i.test(shell)) { argv = ['/d', '/s', '/c', '"' + command + '"']; verbatim = true; }
      else argv = ['-c', command];
    }
    const spec = { file: program, args: argv, verbatim, hide: !!opts.windowsHide };
    delete opts.shell;
    opts.windowsVerbatimArguments = false;
    return { file: exe, args: [FLAG, Buffer.from(JSON.stringify(spec), 'utf8').toString('hex')], options: opts, brokered: true };
  }

  function spawnVia(spawn) {
    if (!exe) return spawn;
    return function brokeredSpawn(file, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      const w = wrap(file, args, options);
      return spawn(w.file, w.args, w.options);
    };
  }

  return { available: !!exe, exe, wrap, spawnVia };
}

/* The spec back out of a launcher call (tests, logs): { file, args, verbatim, hide } | null */
function decodeSpec(args) {
  const a = Array.isArray(args) ? args : [];
  if (a[0] !== FLAG || typeof a[1] !== 'string') return null;
  try { return JSON.parse(Buffer.from(a[1], 'hex').toString('utf8')); } catch (_) { return null; }
}

module.exports = { makeBreakaway, launcherExe, decodeSpec, FLAG };
