/* node test/desktop-station-stop.test.js — the desktop shell owns its station's whole process tree, and stops it ONE way.

   What used to be true, each a way a station or its children outlived StarNet:
     - the sidecar was a plain child: a hard-killed shell (crash, End Task, an installer stopping it) left it running,
       holding the workspace claim, until the next boot's reaper found it (#31: seven orphaned node.exe at once);
     - RESTART and START FRESH ended the sidecar with a bare TerminateProcess: no graceful ask, so the station browser and
       every command behind cmd.exe (an MCP server, a dev server, a self-detached Start-Process child) stayed behind;
     - the updater's pre-exit hook did the same right before NSIS rewrote the install directory;
     - five stop paths each had their own copy of "ask, wait, kill".
   Now: every attempt is placed in a kill-on-close Job Object (sidecar_startup.rs + process_job.rs; the real-process
   proofs are Rust unit tests there), every stop goes through stop_station (ask, end, then end what the station left in
   its job, sparing a window on the user's screen), the sidecar is told who its owner is (STARNET_PARENT_PID, for its
   parent watch) and how to open an app for the person outside the job (STARNET_BREAKAWAY_EXE, the shell's own
   `--starnet-breakaway` mode, checked before anything else of the app starts). These are source locks, each sliced to
   the one Rust function it is about; the Rust tests prove the behaviour. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const main = read('src-tauri/src/main.rs');
const startup = read('src-tauri/src/sidecar_startup.rs');
const job = read('src-tauri/src/process_job.rs');
const cargo = read('src-tauri/Cargo.toml');

/* One Rust fn (or method) by name: from `fn name` to its matching closing brace. Braces inside string literals and
   comments are skipped well enough for this source (no raw strings hold braces in these functions). '' when absent. */
function rustFn(src, name, from) {
  const re = new RegExp('\\bfn ' + name + '\\b');
  const m = re.exec(src.slice(from || 0));
  if (!m) return '';
  const start = (from || 0) + m.index;
  const open = src.indexOf('{', start);
  let depth = 0, i = open, inStr = false, inLine = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === '"') inStr = false; continue; }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}

// ---- every attempt is held by a job ----
const spawnFn = rustFn(startup, 'spawn');
A.ok(/ProcessJob::for_station\(\)/.test(spawnFn) && /job\.assign\(&child\)/.test(spawnFn), 'every sidecar attempt is created into its own station job');
A.ok(/end_leftovers/.test(spawnFn) && spawnFn.indexOf('end_leftovers') < spawnFn.indexOf('command.spawn()'),
  'what an exited sidecar left behind is ended BEFORE its successor starts');
A.ok(/sidecar: Mutex<Option<sidecar_startup::OwnedSidecar>>/.test(main), 'the shell\'s sidecar slot holds the process together with its job');
A.ok(/end_leftovers/.test(rustFn(startup, 'stop_timed_out')), 'a timed-out attempt takes what it started with it');
A.ok(/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE[\s\S]{0,120}JOB_OBJECT_LIMIT_BREAKAWAY_OK/.test(rustFn(job, 'for_station')), 'the job kills on close and lets a deliberate breakaway out');
A.ok(/"Win32_System_JobObjects"/.test(cargo), 'the Job Object API is compiled in');

// ---- ONE stop routine ----
const stop = rustFn(main, 'stop_station');
A.ok(stop.length > 0, 'stop_station exists');
A.ok(/post_sidecar_quit\(/.test(stop) && /terminate_sidecar_child\(/.test(stop) && /end_leftovers\(\)/.test(stop) && /log_lines\(/.test(stop),
  'stop_station asks, ends the sidecar, ends what it left behind, and logs every process it decided about');
A.ok(stop.indexOf('post_sidecar_quit(') < stop.indexOf('terminate_sidecar_child(') && stop.indexOf('terminate_sidecar_child(') < stop.indexOf('end_leftovers()'),
  'in that order');
const terminateCalls = (main.match(/terminate_sidecar_child\(&mut/g) || []).length;
A.eq(terminateCalls, 1, 'nothing but stop_station ends the sidecar process directly');
A.ok(!/\.sidecar\.lock\(\)[^;]*\.take\(\)/.test(main.replace(stop, '')), 'no stop path takes the child out of the slot on its own');
A.ok(/stop_station\(self, StopHow::Now/.test(rustFn(main, 'kill_sidecar')), 'kill_sidecar is the routine without the ask');
A.ok(/stop_station\(state, StopHow::Ask/.test(rustFn(main, 'stop_sidecar_gracefully')), 'stop_sidecar_gracefully is the routine with the ask');
A.ok(/stop_station\(st, StopHow::Ask, "restart"\)/.test(rustFn(main, 'starnet_restart_sidecar')), 'RESTART STATION SERVICE stops through the routine (graceful first)');
A.ok(/let stopped_pid = stop_station\(st, StopHow::Ask, "fresh start"\)/.test(rustFn(main, 'starnet_start_fresh')), 'START FRESH stops through the routine and keeps the stopped pid for the claim check');
A.ok(/stop_sidecar_gracefully\(st\)/.test(rustFn(main, 'starnet_erase_everything')), 'ERASE stops through the routine');
const update = rustFn(main, 'starnet_update_check');
A.ok(/on_before_exit\(move \|\| \{[\s\S]*?shutting_down\.store\(true[\s\S]*?stop_sidecar_gracefully\(state\.inner\(\)\)/.test(update), 'the updater stops the station through the routine before NSIS runs');
A.ok(!/kill_sidecar\(\)/.test(update), 'and never with a bare kill');
A.ok(/fn quit_was_accepted/.test(main) && /quit_was_accepted\(&buf\[\.\.n\]\)/.test(rustFn(main, 'post_sidecar_quit')), 'the ask only waits for a sidecar that accepted');

// ---- the sidecar knows its owner and the breakaway door ----
const command = rustFn(main, 'sidecar_command');
A.ok(/set_sidecar_branded_env\(&mut cmd, "SKYNET_PARENT_PID", std::process::id\(\)\.to_string\(\)\)/.test(command), 'the sidecar is told the shell\'s pid (its parent watch)');
A.ok(/"SKYNET_BREAKAWAY_EXE"/.test(command) && /env_remove\("STARNET_BREAKAWAY_EXE"\)/.test(command), 'the sidecar is told the breakaway launcher on Windows, and an inherited one is removed elsewhere');
const mainFn = rustFn(main, 'main');
A.ok(mainFn.indexOf('process_job::breakaway_main()') >= 0 && mainFn.indexOf('process_job::breakaway_main()') < mainFn.indexOf('tauri::generate_context!()'),
  'the breakaway launcher runs before Tauri, the single-instance check or anything else of the app');
A.ok(/CREATE_BREAKAWAY_FROM_JOB/.test(rustFn(job, 'breakaway_command')) && /raw_os_error\(\) == Some\(5\)/.test(rustFn(job, 'run_breakaway')),
  'the launcher breaks away, and still runs the program when an outer job refuses');

// ---- every reaper skip is logged ----
const reapWin = main.slice(main.indexOf('#[cfg(windows)]\nfn reap_orphan_sidecars'), main.indexOf('#[cfg(target_os = "macos")]\nfn mac_process_image_path'));
A.ok(/sidecar_reap::kept_reason\(/.test(reapWin), 'Windows: every process the reap spares is logged with why');
A.ok(/skipped orphan pid=\{pid\} — could not open it/.test(reapWin) && /skipped pid=\{pid\} — it no longer runs the bundled node/.test(reapWin), 'Windows: an orphan the reap could not end is logged');
const reapMac = rustFn(main, 'reap_orphan_sidecars', main.indexOf('#[cfg(target_os = "macos")]\nfn reap_orphan_sidecars'));
A.ok(/sidecar_reap::kept_reason\(/.test(reapMac) && /skipped orphan pid=\{pid\}/.test(reapMac), 'macOS: the same');

A.report('desktop-station-stop');
