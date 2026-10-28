/* sidecar/tools/builtin/terminal.js — model-facing tools for owned PTY / ConPTY sessions. */
'use strict';

const Shell = require('./shell.js');
const RunPaths = require('../../run-paths.js');

function makeTerminalTools(deps) {
  deps = deps || {};
  const manager = deps.manager;
  const environment = deps.environment;
  const fs = deps.fs;
  const P = deps.pathMod;
  const ROOT = deps.root;
  const platform = deps.platform || process.platform;
  const isWin = platform === 'win32';
  const envFor = typeof deps.envFor === 'function' ? deps.envFor : (() => process.env);
  if (!manager || !environment || !fs || !P || !ROOT) throw new Error('terminal tools require manager, environment, fs, pathMod, and root');

  function aid(ctx) { return Shell.safeAgentId((ctx && ctx.agentId) || 'agent'); }
  function remoteOwner(ctx) { return Shell.unrestrictedHost(ctx); }
  // the run's path object (sidecar/run-paths.js): ctx.paths in a real run, minted from these deps in a rig
  let pathsResolver = null;
  function runPaths(ctx, agentId) {
    if (!pathsResolver) pathsResolver = RunPaths.makeResolver({ pathMod: P, root: ROOT, environment });
    return RunPaths.pathsFor(ctx, pathsResolver, agentId);
  }
  function resolveCwd(args, ctx, agentId) {
    const jailRoot = environment.ensureWorkspace(agentId);
    const paths = runPaths(ctx, agentId);
    // The terminal opens where THIS run's next shell command would (Shell.runShellCwd): the run's project root
    // (host-minted, re-validated before it entered the run) or the private workspace, then the run's own `cd`. It
    // read the run's projectCwd field alone, so a project conversation's terminal opened in the private workspace
    // while its shell and fs.* worked in the project. A PTY runs on the host only, so the backend here is always local.
    let cwd = Shell.runShellCwd({ paths, environment, backendId: 'local', agentId, jailRoot, pathMod: P, fs, root: ROOT, isWin, remoteOwner: remoteOwner(ctx) });
    // User/model args stay inside the private workspace, or inside the run's own project root — the folder this
    // run's shell and fs.* already work in — unless a separately minted remote-owner authority exists.
    if (args && args.cwd != null) {
      const wanted = String(args.cwd).trim();
      const norm = Shell.normalizeWinCwd(P, wanted, isWin);
      const lexical = P.isAbsolute(norm) || /^[A-Za-z]:[\\/]/.test(norm) ? P.resolve(norm) : P.resolve(cwd, norm);
      // inside the project by its REAL path too: a link or junction planted in the project cannot carry the cwd out
      let inRoot = false;
      if (paths.root && !/^\\\\/.test(wanted) && Shell.withinJail(P, lexical, paths.root) && typeof fs.realpathSync === 'function') {
        try { inRoot = Shell.withinJail(P, fs.realpathSync(lexical), fs.realpathSync(paths.root)); }
        catch (e) { require('../../failopen.js').note('terminal.cwd.real', e); }   // not there: resolveShellCwd names why
      }
      cwd = Shell.resolveShellCwd({ pathMod: P, fs, requested: args.cwd, current: cwd, jailRoot, root: ROOT, isWin, allowExternal: remoteOwner(ctx) || inRoot, allowProtected: remoteOwner(ctx) });
    }
    return { cwd, jailRoot };
  }
  function safety(command, cwd, ctx) {
    if (remoteOwner(ctx)) return null;
    const escaped = Shell.escapesWorkspace(command);
    if (escaped) return { kind: 'workspace', reason: escaped };
    return Shell.commandSafetyRisk(command, { cwd, fs, pathMod: P, dialect: isWin ? 'cmd' : 'posix', isWin });
  }
  function sessionRef(args) { return String((args && args.session) || '').trim(); }
  function fail(r) { if (!r || !r.ok) throw new Error((r && r.error) || 'terminal operation failed'); return r; }
  function terminalSummary(s) {
    return '[' + s.name + '] ' + String(s.state || 'unknown').toUpperCase()
      + ' · ' + s.cols + 'x' + s.rows
      + (s.pid ? ' · pid ' + s.pid : '')
      + (s.exitCode != null ? ' · exit ' + s.exitCode : '')
      + (s.reason ? ' · ' + s.reason : '');
  }

  const startTool = {
    name: 'terminal.start', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
    description: 'Start a named interactive terminal session in your workspace using a real PTY/ConPTY. Use this '
      + 'for REPLs, interactive CLIs, and long-running commands that need terminal behavior. The session survives '
      + 'agent turns while this StarNet process lives; use terminal.read/write/resize/interrupt/stop to control it.',
    schema: {
      type: 'object', required: ['name', 'command'],
      properties: {
        name: { type: 'string' }, command: { type: 'string' }, cwd: { type: 'string' },
        cols: { type: 'number' }, rows: { type: 'number' }
      }
    },
    run: async function (args, ctx) {
      const agentId = aid(ctx), command = String((args && args.command) || '').trim();
      if (!command) throw new Error('empty command');
      // Lane C: a PTY is spawned on the HOST by node-pty. If this agent's profile asks for a sandbox, the
      // terminal must not quietly escape it — honor the sandbox or refuse, with the fix named.
      const refusal = typeof environment.refusalFor === 'function' ? environment.refusalFor(agentId) : null;
      if (refusal) throw refusal;
      const resolution = typeof environment.resolutionFor === 'function' ? environment.resolutionFor(agentId) : null;
      const environmentBackendId = resolution ? resolution.id : (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(agentId) : environment.backendId);
      if (environmentBackendId !== 'local') {
        const e = new Error('interactive terminals run on the host; this agent is sandboxed (profile ' + String((resolution && resolution.profileId) || 'unknown') + ' → ' + environmentBackendId + '). Use shell.exec inside the sandbox, or change the agent execution profile to Trusted Project or This Computer.');
        e.precondition = { code: 'terminal_requires_local_backend', requiredState: 'local_execution_backend', requiredAction: 'use_shell_exec_or_change_execution_profile' };
        throw e;
      }
      const where = resolveCwd(args, ctx || {}, agentId);
      const risk = safety(command, where.cwd, ctx || {});
      if (risk) throw new Error('refused [' + risk.kind + ']: this terminal command ' + risk.reason);
      if (ctx && typeof ctx.checkpointMutation === 'function') {
        try { await ctx.checkpointMutation(where.cwd, 'terminal.start', { always: true }); } catch (_) {}
      }
      const result = fail(manager.start({
        agentId, name: args.name, command, cwd: where.cwd, cols: args.cols, rows: args.rows,
        env: envFor(ctx && ctx.surface)
      }));
      const durable = result.persisted ? ' Metadata is durable.' : ' WARNING: metadata could not be persisted; this session exists only in the current sidecar life.';
      return {
        content: terminalSummary(result.session) + '\nStarted as ' + result.session.sessionId + '.' + durable
          + '\nRead output with terminal.read {session:"' + result.session.name + '"}.',
        summary: 'terminal ' + result.session.name + ' started'
      };
    }
  };

  /* IMPACT (declared, never inferred: an undeclared tool fails closed to external-unknown, which withheld these from
     every unattended run, granted terminal or not, and asked a per-call confirmation for each read on a watched one).
     start/write are workspace-process: they run commands. status/read/resize/interrupt/stop are none: they act only
     on THIS agent's own sessions (manager calls are keyed by aid(ctx)), start nothing, send no input a shell could
     run and reach no network. Ctrl-C and stop end work, like shell.bg.kill; resize only redraws. */
  const statusTool = {
    name: 'terminal.status', capability: 'workbench', impact: 'none', scope: 'read', requiresConsent: false,
    description: 'List your terminal sessions, or inspect one by name/id. Lifecycle truth includes whether the '
      + 'process is attached in this sidecar life; prior-life sessions are reported unknown, never falsely running.',
    schema: { type: 'object', properties: { session: { type: 'string' } } },
    run: function (args, ctx) {
      const agentId = aid(ctx), ref = sessionRef(args);
      if (ref) {
        const s = manager.status(agentId, ref);
        if (!s) return { content: 'No terminal session "' + ref + '".', summary: 'not found' };
        return { content: terminalSummary(s) + '\n' + JSON.stringify(s), summary: s.name + ' ' + s.state };
      }
      const rows = manager.status(agentId);
      const health = manager.storeHealth();
      if (!rows.length) return { content: 'No terminal sessions. Metadata store: ' + JSON.stringify(health), summary: '0 terminals' };
      return { content: rows.map(terminalSummary).join('\n') + '\nMetadata store: ' + JSON.stringify(health), summary: rows.length + ' terminal(s)' };
    }
  };

  const readTool = {
    name: 'terminal.read', capability: 'workbench', impact: 'none', scope: 'read', requiresConsent: false,
    description: 'Read bounded scrollback from one terminal. Pass the returned nextOffset on the next call to '
      + 'continue without duplicates. If old output fell out of the bounded ring, truncatedStart says so explicitly.',
    schema: {
      type: 'object', required: ['session'],
      properties: { session: { type: 'string' }, offset: { type: 'number' }, maxChars: { type: 'number' } }
    },
    run: function (args, ctx) {
      const r = fail(manager.read(aid(ctx), sessionRef(args), { offset: args.offset, maxChars: args.maxChars }));
      const saved = r.session.outputSpillVerified
        ? '; full ' + r.session.outputBytes + '-byte output saved once at ' + runPaths(ctx, aid(ctx)).placeJail(r.session.outputPath) + ' (page with fs.read)'
        : (r.session.outputSpillError ? '; durable output spill failed: ' + r.session.outputSpillError : '');
      const note = '[offset ' + r.offset + '→' + r.nextOffset + ' of ' + r.endOffset
        + (r.truncatedStart ? '; earlier output left the bounded scrollback' : '') + saved
        + (r.hasMore ? '; more available' : '') + ']';
      return { content: (r.output || '(no output)') + '\n' + note + '\n' + terminalSummary(r.session), summary: r.output.length + ' chars · ' + r.session.state };
    }
  };

  const writeTool = {
    name: 'terminal.write', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
    description: 'Send text to a running terminal. By default submits it with Enter; set submit:false for '
      + 'character-at-a-time input. Input is screened like a shell command because a terminal can execute it.',
    schema: {
      type: 'object', required: ['session', 'data'],
      properties: { session: { type: 'string' }, data: { type: 'string' }, submit: { type: 'boolean' } }
    },
    run: async function (args, ctx) {
      const agentId = aid(ctx), ref = sessionRef(args), data = String(args.data == null ? '' : args.data);
      if (!data) throw new Error('empty input');
      const s = manager.status(agentId, ref);
      if (!s) throw new Error('no such terminal session');
      const risk = safety(data, s.cwd, ctx || {});
      if (risk) throw new Error('refused [' + risk.kind + ']: this terminal input ' + risk.reason);
      if (ctx && typeof ctx.checkpointMutation === 'function') {
        try { await ctx.checkpointMutation(s.cwd, 'terminal.write', { always: true }); } catch (_) {}
      }
      const r = fail(manager.write(agentId, ref, { data, submit: args.submit }));
      return { content: 'Sent ' + r.bytes + ' byte(s) to ' + r.session.name + '. Read the response with terminal.read.', summary: 'terminal input sent' };
    }
  };

  const resizeTool = {
    name: 'terminal.resize', capability: 'workbench', impact: 'none', scope: 'write', requiresConsent: false,
    description: 'Resize a running terminal so full-screen and width-sensitive programs redraw correctly.',
    schema: { type: 'object', required: ['session', 'cols', 'rows'], properties: { session: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } } },
    run: function (args, ctx) {
      const r = fail(manager.resize(aid(ctx), sessionRef(args), args.cols, args.rows));
      return { content: 'Resized ' + r.session.name + ' to ' + r.session.cols + 'x' + r.session.rows + (r.persisted ? '.' : ' (metadata is not durable).'), summary: r.session.cols + 'x' + r.session.rows };
    }
  };

  const interruptTool = {
    name: 'terminal.interrupt', capability: 'workbench', impact: 'none', scope: 'write', requiresConsent: false,
    description: 'Send Ctrl-C to a running terminal. This reports that the interrupt was sent; inspect status/read '
      + 'to learn what the process actually did.',
    schema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } } },
    run: function (args, ctx) {
      const r = fail(manager.interrupt(aid(ctx), sessionRef(args)));
      return { content: 'Sent Ctrl-C to ' + r.session.name + '. Its resulting state is not assumed; check terminal.status/read.', summary: 'interrupt sent' };
    }
  };

  const stopTool = {
    name: 'terminal.stop', capability: 'workbench', impact: 'none', scope: 'write', requiresConsent: false,
    description: 'Request stop for one of your terminal sessions. The whole owned process tree is targeted. This '
      + 'does not claim exit until the PTY emits its actual exit event; check terminal.status.',
    schema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } } },
    run: function (args, ctx) {
      const r = fail(manager.stop(aid(ctx), sessionRef(args)));
      if (r.alreadyExited) return { content: terminalSummary(r.session), summary: 'already ' + r.session.state };
      return { content: 'Stop requested for ' + r.session.name + '; awaiting its exit event. Check terminal.status.', summary: 'stop requested' };
    }
  };

  const all = [startTool, statusTool, readTool, writeTool, resizeTool, interruptTool, stopTool];
  return { tools: all, register: function (registry) { all.forEach(t => registry.register(t)); return registry; }, _internals: { resolveCwd, safety, terminalSummary } };
}

module.exports = { makeTerminalTools };
