/* Checkpoint Git commands share the foreground process supervisor: timeout/abort must stop the whole
   owned tree before another checkpoint starts. execFile's timeout only killed git, leaving pack-objects.
   Capture streams separately because rev-parse/log parse stdout as data, never diagnostic stderr. */
'use strict';
const { runProcess } = require('./environment.js');
const { StringDecoder } = require('node:string_decoder');
/* What a process's environment can set for another repository or for every pathspec (git rev-parse --local-env-vars, and the
   pathspec switches): a station started from a Git hook or script inherits them, and they would reach a shadow repo's calls past
   its --git-dir (GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY) and past every literal pathspec its checks ask by (GIT_LITERAL_PATHSPECS:
   no .gitignore listed, no rule refused, undo review 7's family). The person's own config files stay (the store pins what it must). */
const GIT_ENV_OF_ANOTHER_REPO = /^GIT_(?:DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|NAMESPACE|PREFIX|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|ATTR_SOURCE)$/i;
function checkpointGitEnv() {
  const env = {};
  for (const name of Object.keys(process.env)) if (!GIT_ENV_OF_ANOTHER_REPO.test(name)) env[name] = process.env[name];
  return env;
}
function makeCheckpointGitRunner(deps) {
  const d = deps || {};
  return async function runGitCheckpoint(args, opts) {
    let stdout = '', stderr = '';
    // A per-call bound wins over the runner default: shadow-repo maintenance (gc, the re-init add/commit) needs
    // longer than a snapshot's add. Ignoring it killed every gc at the default and left its tmp_pack behind (#107).
    const perCall = Number(opts && opts.timeoutMs);
    const timeoutMs = perCall > 0 && isFinite(perCall) ? perCall : (d.timeoutMs || 15000);
    const maxBytes = d.maxBytes || (8 << 20);
    const controller = new AbortController();
    let outBytes = 0, errBytes = 0, overflow = false;
    const externalSignal = opts && opts.signal;
    const abort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener('abort', abort, { once: true });
    }
    const decOut = new StringDecoder('utf8'), decErr = new StringDecoder('utf8');
    const appendOut = data => { outBytes += Buffer.byteLength(data); stdout = (stdout + (typeof data === 'string' ? data : decOut.write(data))).slice(0, maxBytes); if (outBytes > maxBytes) { overflow = true; abort(); } };
    const appendErr = data => { errBytes += Buffer.byteLength(data); stderr = (stderr + (typeof data === 'string' ? data : decErr.write(data))).slice(0, maxBytes); if (errBytes > maxBytes) { overflow = true; abort(); } };
    const spawn = function (file, argv, options) {
      const child = d.spawn(file, argv, options);
      if (file === (d.file || 'git')) {
        if (child.stdout) child.stdout.on('data', appendOut);
        if (child.stderr) child.stderr.on('data', appendErr);
      }
      return child;
    };
    try {
      const result = await runProcess({ spawn, file: d.file || 'git', args, timeoutMs,
        maxBytes, captureFullOut: false, clock: d.clock, ledger: d.ledger, ledgerCmd: d.file || 'git',
        signal: controller.signal,
        spawnOptions: { cwd: opts && opts.cwd || d.cwd, env: checkpointGitEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } });
      stdout = (stdout + decOut.end()).slice(0, maxBytes);
      stderr = (stderr + decErr.end()).slice(0, maxBytes);
      if (result.timedOut) stderr += '\ncheckpoint Git process tree timed out';
      if (overflow) stderr += '\ncheckpoint Git output limit exceeded';
      else if (result.aborted) stderr += '\ncheckpoint Git process tree aborted';
      return { code: overflow ? -1 : result.exitCode, stdout, stderr, truncated: overflow, timedOut: result.timedOut, aborted: result.aborted };
    } catch (e) {
      // a launch that failed (spawn threw, or emitted 'error'): -1, as runProcess answers a timeout or an abort, never an exit code a
      // Git command gives. check-ignore's 1 means none ignored and grep's no line at all: this answered 1 (undo review 7)
      return { code: -1, stdout, stderr: stderr + String(e && e.message || e) };
    }
    finally { if (externalSignal) externalSignal.removeEventListener('abort', abort); }
  };
}
module.exports = { makeCheckpointGitRunner };
