/* sidecar/capability/withheld.js — WHY a placed power is missing from THIS run, and what gets the work done instead.

   ISSUE #77. A delegated worker in a project conversation (ASK mode, WORKBENCH placed) told the Commander "shell
   execution is unavailable": its tool list held shell_bg_status/kill/wait but no shell_exec, tool_search answered
   with an unrelated browser tool, and its ground-truth note called it an "UNATTENDED routine" needing a
   "per-routine grant" — none of which it, or the Commander, could act on.

   The withholding itself is BY DESIGN and stays: makeRunAuthority (inputpolicy.js) projects no workspace-process
   tool (shell.exec, shell.bg.write, terminal.start/write, verify.run, code.run) onto a non-interactive surface in ASK mode
   unless the host recorded an unattended terminal grant, and a delegated worker runs surface:'autonomous'
   (orchestration.js says widening that is a deliberate permissions decision). What was wrong is what the agent was
   TOLD. This module is the one wording of that fact, used by the capability note, tool.search and the WITHHELD
   dispatch reply, so all three say the same true thing: what is withheld, why, and the step that actually works.

   Pure: no I/O, no policy. It only explains a decision makeRunAuthority already made. */
'use strict';

const COMMAND_TOOLS = 'shell_exec, shell_bg_write, terminal_start, terminal_write, verify_run and code_run';

// the delegated worker: hand the command back to the lead's watched conversation, where ASK approval exists
function delegatedCommandGap(lead) {
  const who = String(lead == null ? '' : lead).trim() || 'the lead agent that delegated this task';
  return {
    why: 'you are a worker delegated by ' + who + ', and in ASK mode StarNet withholds command execution (' + COMMAND_TOOLS
      + ') from delegated workers even when a WORKBENCH is placed: a command needs the Commander\'s approval in a watched '
      + 'conversation, and a delegated run is not one',
    enable: 'put the exact command(s), and the folder to run them in, in your result for ' + who + ' so they can be run in '
      + 'the Commander\'s watched conversation, where each command is approved under ASK. Placing more objects cannot change '
      + 'this; only Full Access for this agent (whole-computer authority) would'
  };
}

function routineCommandGap() {
  return {
    why: 'this is an unattended routine run and the routine has no terminal grant',
    enable: 'the Commander grants this routine terminal access in the ROUTINES panel, or runs the command in a watched conversation'
  };
}

function unattendedCommandGap() {
  return {
    why: 'this is an unattended run (nobody is watching to approve a command)',
    enable: 'run the command from a watched StarNet conversation, where it is approved under ASK'
  };
}

// opts: { delegatedBy, routine } -> { why, enable }
function commandGap(opts) {
  opts = opts || {};
  if (String(opts.delegatedBy || '').trim()) return delegatedCommandGap(opts.delegatedBy);
  if (opts.routine) return routineCommandGap();
  return unattendedCommandGap();
}

/* withheldCommandTools(names, { impactOf, opts }) -> { name: { why, enable } }
   `names` = the tools the run authority REMOVED from this run's grant (granted-by-floor minus projected). Only the
   workspace-process class is explained here; other withheld classes keep their existing wording. */
function withheldCommandTools(names, deps) {
  deps = deps || {};
  const impactOf = typeof deps.impactOf === 'function' ? deps.impactOf : (() => '');
  const out = {};
  for (const n of (names || [])) {
    if (impactOf(n) !== 'workspace-process') continue;
    out[n] = commandGap(deps.opts);
  }
  return out;
}

module.exports = { commandGap, delegatedCommandGap, withheldCommandTools, COMMAND_TOOLS };
