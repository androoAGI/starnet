/* test/helpers/shell-marker.js — what a REAL shell prints for shell.exec's appended marker (shell.js buildMarkedCmd).

   Since run-paths review S1 (2026-10-28) every marker token carries a fresh per-call nonce (__SK_CWD_<nonce>__ …), so
   printed file content cannot forge the run's cwd or exit code. A fake spawn/execute reads the nonce back off the
   marked command it was handed, exactly as cmd.exe or sh would echo it. A command built without a nonce (an old rig
   calling buildMarkedCmd directly) gets the historic un-nonced marker. */
'use strict';

function nonceOf(markedCmd) {
  const m = /__SK_CWD_([0-9A-Za-z]+)__/.exec(String(markedCmd == null ? '' : markedCmd));
  return m ? m[1] : '';
}

// echoMarker(markedCmd, cwd, ec) -> the marker line the shell prints after the command
function echoMarker(markedCmd, cwd, ec) {
  const n = nonceOf(markedCmd);
  const t = n ? '_' + n : '';
  return '__SK_CWD' + t + '__' + cwd + '__SK_EC' + t + '__' + ec + '__SK_END' + t + '__';
}

module.exports = { echoMarker, nonceOf };
