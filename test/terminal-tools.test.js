/* node test/terminal-tools.test.js — workbench registration and host-side safety/checkpoint wiring. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTerminalTools } = require('../sidecar/tools/builtin/terminal.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-terminal-tools-'));
  const workspace = path.join(root, 'a1'); fs.mkdirSync(workspace, { recursive: true });
  const calls = [];
  const manager = {
    start(o) { calls.push(['start', o]); return { ok: true, persisted: true, session: { sessionId: 'term_1', name: o.name, state: 'running', cols: o.cols || 120, rows: o.rows || 30, pid: 8, cwd: o.cwd, command: o.command } }; },
    status(agent, ref) {
      calls.push(['status', agent, ref]);
      if (ref) return { sessionId: 'term_1', name: 'repl', state: 'running', cols: 120, rows: 30, pid: 8, cwd: workspace, command: 'python -i' };
      return [];
    },
    read() { return { ok: true, output: 'ready', offset: 0, nextOffset: 5, endOffset: 5, truncatedStart: false, hasMore: false, session: { name: 'repl', state: 'running', cols: 120, rows: 30 } }; },
    write(agent, ref, o) { calls.push(['write', agent, ref, o]); return { ok: true, bytes: o.data.length + 1, session: { name: 'repl' } }; },
    resize() { return { ok: true, persisted: true, session: { name: 'repl', cols: 100, rows: 40 } }; },
    interrupt() { return { ok: true, sent: true, session: { name: 'repl' } }; },
    stop() { return { ok: true, requested: true, session: { name: 'repl' } }; },
    storeHealth() { return { loaded: 'ok', persisted: true, error: null }; }
  };
  const environment = {
    backendId: 'local', ensureWorkspace: () => workspace, getCwd: () => workspace
  };
  const family = makeTerminalTools({ manager, environment, fs, pathMod: path, root, platform: process.platform, envFor: () => ({ PATH: 'safe-path' }) });
  const names = family.tools.map(t => t.name);
  A.eq(names, ['terminal.start', 'terminal.status', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.interrupt', 'terminal.stop'], 'complete terminal control surface is registered');
  A.ok(family.tools.every(t => t.capability === 'workbench'), 'every terminal tool is capability-gated by the existing Workbench object');
  A.ok(family.tools.find(t => t.name === 'terminal.start').requiresConsent, 'starting arbitrary terminal code requires consent');
  A.ok(family.tools.find(t => t.name === 'terminal.write').requiresConsent, 'terminal input requires consent because it can execute code');
  A.ok(!family.tools.find(t => t.name === 'terminal.read').requiresConsent, 'reading owned scrollback needs no new approval');

  let checkpoints = 0;
  const ctx = { agentId: 'a1', surface: 'interactive', checkpointMutation: async (cwd, label) => { checkpoints++; calls.push(['checkpoint', cwd, label]); } };
  const start = family.tools.find(t => t.name === 'terminal.start');
  const result = await start.run({ name: 'repl', command: 'python -i', cols: 100, rows: 40 }, ctx);
  A.ok(/Started as term_1/.test(result.content), 'start returns the real manager session identity');
  A.eq(checkpoints, 1, 'terminal start checkpoints before process creation');
  // the PTY starts in the REAL folder its proof saw (macOS tmpdir is /var -> /private/var), so compare real paths
  A.eq(calls.find(x => x[0] === 'start')[1].cwd, fs.realpathSync(workspace), 'terminal starts in the agent-owned workspace');
  A.eq(calls.find(x => x[0] === 'start')[1].env, { PATH: 'safe-path' }, 'host-sanitized child environment is passed to PTY spawn');

  let refused = false;
  try { await start.run({ name: 'bad', command: 'explorer.exe .' }, ctx); } catch (e) { refused = /refused/.test(e.message); }
  A.ok(refused, 'visible-window commands are refused before PTY creation');
  A.eq(calls.filter(x => x[0] === 'start').length, 1, 'refused terminal command never reaches the manager');

  const write = family.tools.find(t => t.name === 'terminal.write');
  const wrote = await write.run({ session: 'repl', data: 'hello' }, ctx);
  A.ok(/Sent 6 byte/.test(wrote.content), 'terminal input reports manager-confirmed bytes');
  A.eq(checkpoints, 2, 'terminal input checkpoints before it can mutate workspace state');

  const read = family.tools.find(t => t.name === 'terminal.read').run({ session: 'repl' }, ctx);
  A.ok(/ready/.test(read.content) && /offset 0→5/.test(read.content), 'scrollback result carries output and continuation cursor');
  const interrupt = family.tools.find(t => t.name === 'terminal.interrupt').run({ session: 'repl' }, ctx);
  A.ok(/resulting state is not assumed/.test(interrupt.content), 'interrupt copy does not falsely claim the process stopped');
  const stop = family.tools.find(t => t.name === 'terminal.stop').run({ session: 'repl' }, ctx);
  A.ok(/awaiting its exit event/.test(stop.content), 'stop copy waits for observed exit truth');

  /* REVIEW ROUND 2. (m-term-junction) a junction INSIDE the private workspace named as the cwd passed every lexical check
     and opened the PTY outside; the real cwd must be inside the real workspace (or the real, still-approved root).
     (m-rootApproved) the host's approval check is an exact key match, so it is asked with the root's REAL path: a root
     spelled with a trailing separator is the same approved folder. */
  {
    const RunPaths = require('../sidecar/run-paths.js');
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-terminal-ext-'));   // beside the workspaces root, never in it
    const outside = path.join(ext, 'outside'), proj = path.join(ext, 'proj');
    fs.mkdirSync(outside, { recursive: true }); fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    let planted = false;
    try { fs.symlinkSync(outside, path.join(workspace, 'jx'), process.platform === 'win32' ? 'junction' : 'dir'); planted = true; }
    catch (e) { console.log('[skip] could not plant a junction: ' + e.message); }
    const approved = fs.realpathSync(proj);
    const fam2 = makeTerminalTools({ manager, environment, fs, pathMod: path, root, platform: process.platform, envFor: () => ({}), rootApproved: (r) => r === approved });
    const start2 = fam2.tools.find(t => t.name === 'terminal.start');
    const resolver = RunPaths.makeResolver({ pathMod: path, root, environment: Object.assign({}, environment, { workspaceRoot: () => workspace }) });
    const runIn = (projectRoot) => ({ agentId: 'a1', surface: 'interactive', paths: RunPaths.makeRunPaths(resolver, { agentId: 'a1', projectRoot }) });
    const before = calls.filter(x => x[0] === 'start').length;
    if (planted) {
      let why = '';
      try { await start2.run({ name: 'jx', command: 'echo hi', cwd: 'jx' }, runIn('')); } catch (e) { why = e.message; }
      A.ok(/outside your workspace by its real path/.test(why), 'a junction in the workspace pointing out never becomes the terminal folder (' + why + ')');
      A.eq(calls.filter(x => x[0] === 'start').length, before, 'and nothing reached the manager');
    }
    let spelled = null;
    try { spelled = await start2.run({ name: 'p1', command: 'echo hi', cwd: 'src' }, runIn(proj + path.sep)); } catch (e) { spelled = { content: 'refused: ' + e.message }; }
    A.ok(/Started/.test(spelled.content), 'a still-approved root spelled with a trailing separator is still approved (' + spelled.content.slice(0, 80) + ')');
    A.eq(calls.filter(x => x[0] === 'start').pop()[1].cwd, path.join(approved, 'src'), 'and the terminal opens in its real folder');
    /* REVIEW ROUND 3 (minor-5): a cwd of ".git" inside the project or the private workspace's repo opened the PTY there.
       The real folder meets the floor; the remote-owner path keeps its own authority. */
    fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'repo', '.git'), { recursive: true });
    const floorBefore = calls.filter(x => x[0] === 'start').length;
    for (const [label, cwd, ctx2] of [['the project .git', '.git', runIn(proj)], ['a folder inside the project .git', '.git/hooks', runIn(proj)],
      ['the private workspace repo .git', 'repo/.git', runIn('')], ['the project .git by a case variant', '.GIT', runIn(proj)]]) {
      if (cwd === '.GIT' && process.platform !== 'win32') continue;
      let why = '';
      try { await start2.run({ name: 'g' + floorBefore, command: 'echo hi', cwd }, ctx2); why = 'STARTED'; } catch (e) { why = e.message; }
      A.ok(/protected folder/.test(why), 'terminal.start in ' + label + ' is refused (' + why + ')');
    }
    A.eq(calls.filter(x => x[0] === 'start').length, floorBefore, 'no protected folder reached the manager');
    let repoOk = null;
    try { repoOk = await start2.run({ name: 'r1', command: 'echo hi', cwd: 'repo' }, runIn('')); } catch (e) { repoOk = { content: 'refused: ' + e.message }; }
    A.ok(/Started/.test(repoOk.content), 'the repo folder itself still opens a terminal (' + repoOk.content.slice(0, 80) + ')');
    if (planted) fs.unlinkSync(path.join(workspace, 'jx'));
    fs.rmSync(ext, { recursive: true, force: true });
    // and the run host hands every run's terminal tools that live check (sliced to runOnceCore, where the tools are built)
    const core = require('./helpers/source').sidecarTopLevelFunction('runOnceCore');
    A.ok(core.length > 0 && /makeTerminalTools\(\{[\s\S]{0,1500}?rootApproved: \(root\) => isBlessedRoot\(root\)/.test(core), 'runOnceCore wires terminal.start to the live approval check');
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  A.report('terminal-tools');
})().catch(e => { console.error(e); process.exit(1); });
