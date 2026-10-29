/* sidecar/tools/builtin/verify.js — the WORKBENCH verify.run tool (execution-spine Commit 4): run the project's
   own check (tests/build) in the jail and report a pass/fail VERDICT — the proof that an edit actually worked.

   The 80/20 of verification: once shell exists, the highest-value signal is "did my change pass the suite." This
   tool runs a configured-or-auto-detected check command through the SAME execution primitive shell.exec uses
   (shell.js runCommand — one battle-tested spawn/timeout/abort core), judges it with the pure sidecar/verify.js
   interpret(), emits the verify.result rung (the war-room pass/fail glow), and hands the model a clear verdict.

   It is a 'workbench'/execute capability exactly like shell.exec — same danger gate: interactive prompts, the
   autonomous EXEC-LOCKOUT denies it, and the host auto-checkpoints before it runs. Edit-time LSP deltas are
   supplied separately by lsp-manager.js at the fs mutation boundary; this test-runner path continues to report
   added/removed = 0 because a project command is a different proof source.

   makeVerifyTool({ spawn, fs, pathMod, root, redact?, clock?, limits? }) -> { verifyTool, register(reg) } */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./shell.js') : (root.SK && root.SK.tools && root.SK.tools.builtin && root.SK.tools.builtin.shell),
    typeof require === 'function' ? require('../../verify.js') : (root.SK && root.SK.verify)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).verify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shell, verifyCore) {
  'use strict';

  const runCommand = shell.runCommand, escapesWorkspace = shell.escapesWorkspace,
    commandSafetyRisk = shell.commandSafetyRisk, safeAgentId = shell.safeAgentId, resolveShellCwd = shell.resolveShellCwd;
  const interpret = verifyCore.interpret;
  const RunPaths = typeof require === 'function' ? require('../../run-paths.js') : null;
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }

  function makeVerifyTool(deps) {
    deps = deps || {};
    const environment = deps.environment || null;
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    if (!environment && (typeof spawn !== 'function' || !fs || !P || !ROOT)) throw new Error('verify.js requires { spawn, fs, pathMod, root } or { environment }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 120000;   // a test suite/build is slower than a shell one-liner
    const MAX_MS = L.maxTimeoutMs || 600000;
    let pathsResolver = null;   // names this run's paths when a rig passes no ctx.paths (sidecar/run-paths.js)

    const verifyTool = {
      name: 'verify.run', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,
      description: 'Run your project\'s check (tests/build) and get back a clear PASS/FAIL verdict — proof your '
        + 'change works. Pass { "cmd": "npm test" } (or your build/lint command); with no cmd it runs "npm test" '
        + 'when a package.json is present. Runs in your workspace; optional timeoutMs (default 2m, max 10m).',
      schema: { type: 'object', properties: { cmd: { type: 'string' }, timeoutMs: { type: 'number' } } },
      run: function (args, ctx) {
        ctx = ctx || {};
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const refusal = shell.sandboxRefusal ? shell.sandboxRefusal(environment, aid) : null;
        if (refusal) throw refusal;
        const environmentBackendId = environment
          ? (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(aid) : environment.backendId)
          : null;
        // the check runs where THIS run's next shell command would (shell.js runShellCwd over the run's path object):
        // its project root or private workspace, then the run's own `cd` — the folder shell.exec and fs.* agree on
        const jailRoot = environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid);
        if (!pathsResolver) pathsResolver = RunPaths.makeResolver({ pathMod: P, root: ROOT, environment });
        const cwd = shell.runShellCwd({ paths: RunPaths.pathsFor(ctx, pathsResolver, aid), environment: environment, backendId: environmentBackendId,
          agentId: aid, jailRoot: jailRoot, pathMod: P, fs: fs, root: ROOT, isWin: isWin, remoteOwner: shell.unrestrictedHost(ctx), confine: true });
        // Local execution may be inside a nested project after shell.cd. Inspect the
        // exact directory that will execute; only mapped backends need the host root.
        const hostCwd = environment && environmentBackendId !== 'local' && typeof environment.workspaceRoot === 'function'
          ? environment.workspaceRoot(aid) : cwd;
        let cmd = String((args && args.cmd) || '').trim();
        if (!cmd) {
          if (fs && fs.existsSync && fs.existsSync(P.join(hostCwd, 'package.json'))) cmd = 'npm test';
          else throw new Error('no check command given and no package.json found — pass { "cmd": "<your check>" }');
        }
        const hostWide = shell.unrestrictedHost(ctx);
        const deny = hostWide ? null : escapesWorkspace(cmd);
        if (deny) throw new Error('refused: ' + deny);
        const safetyDeny = hostWide ? null : commandSafetyRisk(cmd, { cwd: hostCwd, fs: fs, pathMod: P,
          dialect: environment && environmentBackendId !== 'local' ? 'posix' : (isWin ? 'cmd' : 'posix'), isWin: isWin });
        if (safetyDeny) throw new Error('refused [' + safetyDeny.kind + ']: this check ' + safetyDeny.reason + '. verify.run cannot change the user\'s screen, session, processes, input, or network exposure; use browser.test_* for local UI/game verification.');
        if (!environment) { try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {} }
        const checkpoint = typeof ctx.checkpointMutation === 'function'
          ? Promise.resolve().then(function () { return ctx.checkpointMutation(hostCwd, 'verify.run', { always: true }); }).catch(function () { return null; })
          : Promise.resolve(null);
        const timeoutMs = clamp((args && args.timeoutMs) || DEFAULT_MS, 1000, MAX_MS);
        const run = checkpoint.then(function () { return environment && typeof environment.execute === 'function'
          // ctx.surface rides along (host authority): an unattended run receives only the service keys whose
          // unattended grant is flipped ON — the same rule resolveForRequest enforces on web_request.
          ? environment.execute({ agentId: aid, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, surface: ctx.surface })
          : runCommand({ spawn: spawn, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin }); });
        return run.then(function (res) {
          const verdict = interpret(res);
          const body = redact(res.out || '(no output)');
          // the bounded capture (output-capture.js) dropped the middle of a huge output: say so, never imply the saved copy is whole
          const elided = Number(res.fullOutElided) > 0 ? Number(res.fullOutElided) : 0;
          const content = (verdict.passed ? '✓ PASSED' : '✗ FAILED') + ' — `' + cmd + '`\n' + body
            + '\n[exit ' + res.exitCode + (res.truncated ? ', output truncated' : '') + (elided ? ', ' + elided + ' characters from the middle of the output were not kept' : '')
            + (res.timedOut ? ', TIMED OUT' : '') + ']';
          const fullContent = res.truncated && typeof res.fullOut === 'string'
            ? (verdict.passed ? '✓ PASSED' : '✗ FAILED') + ' — `' + cmd + '`\n' + redact(res.fullOut || '(no output)')
              + '\n[exit ' + res.exitCode + (res.timedOut ? ', TIMED OUT' : '') + ']'
            : undefined;
          try {
            if (typeof ctx.emit === 'function') ctx.emit('verify.result', {
              agentId: aid, runId: ctx.runId || '', tool: cmd.slice(0, 60),
              passed: verdict.passed, added: 0, removed: 0, summary: redact(verdict.summary)
            });
          } catch (_) {}
          const done = { content: content, fullContent: fullContent, summary: (verdict.passed ? 'verify passed' : 'verify FAILED') + ' (' + res.ms + 'ms)' };
          if (elided) done.fullContentElided = elided;
          return done;
        });
      }
    };

    return { verifyTool: verifyTool, register: function (reg) { reg.register(verifyTool); return reg; } };
  }

  return { makeVerifyTool: makeVerifyTool };
});
