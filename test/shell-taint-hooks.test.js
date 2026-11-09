/* node test/shell-taint-hooks.test.js — A TAINTED FULL POWER COMMAND DOES NOT TOUCH STARNET'S HOOK FILES (fix-sec2 review2 #13).

   Full Power skips the shell's check on StarNet's own hooks.json. On a station without a key nothing seals hooks.json or
   hooks-allowed.json, so a command a person approved in a run that read outside content could plant an approved hook.
   Locks: a tainted Full Power command naming StarNet's hooks.json or hooks-allowed.json is refused before it runs; an
   untainted Full Power command is unchanged; a project's own hooks.json is unchanged; a taint check that throws refuses.
   The injected environment records commands and never executes them. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
const { echoMarker } = require('./helpers/shell-marker.js');

(async () => {
  const W = path.win32;
  const root = 'C:\\Users\\u\\AppData\\Local\\StarNet\\workspaces';
  const jail = W.join(root, 'agent');
  const hostDir = 'C:\\Users\\u\\proj';
  const calls = [];
  const env = {
    backendId: 'local',
    ensureWorkspace: () => jail, getCwd: () => jail, rememberCwd: () => {},
    execute: o => { calls.push(o); return Promise.resolve({ out: 'ok\n' + echoMarker(o.cmd, hostDir, 0), exitCode: 0, ms: 0, truncated: false, timedOut: false, aborted: false }); }
  };
  const fakeFs = { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) };
  const tool = makeShellTool({ environment: env, fs: fakeFs, pathMod: W, root, clock: { now: () => 0 }, platform: 'win32' }).execTool;
  const run = async (cmd, taintedBy) => {
    const before = calls.length;
    const ctx = { agentId: 'agent', unrestrictedHost: true, inputMode: 'full-power' };
    if (taintedBy !== undefined) ctx.connectorAuthority = { taintedBy };
    try { await tool.run({ cmd, cwd: hostDir }, ctx); return calls.length > before ? 'ran' : 'not-run'; }
    catch (e) { return calls.length > before ? 'ran' : 'refused: ' + String(e.message || e); }
  };
  const own = W.join(root, 'hooks.json');
  const approvals = W.join(root, 'hooks-allowed.json');
  const page = () => 'web.fetch https://pages.example/x';

  A.eq(await run('echo {} > "' + own + '"'), 'ran', 'untainted Full Power: StarNet\'s hooks.json is the operator\'s, as before');
  A.eq(await run('echo {} > "' + approvals + '"'), 'ran', 'untainted Full Power: so are its approvals');
  A.ok(/^refused/.test(await run('echo {} > "' + own + '"', page)), 'tainted Full Power: StarNet\'s hooks.json is refused before it runs');
  A.ok(/^refused: .*hooks-allowed\.json/.test(await run('copy x.json "' + approvals + '"', page)), 'tainted Full Power: its approvals are refused, named');
  A.ok(/^refused/.test(await run('type nul > "' + own + '"', () => { throw new Error('latch unreadable'); })), 'a taint check that throws refuses');
  A.eq(await run('echo {} > hooks.json', page), 'ran', 'a project\'s own hooks.json (resolved in the project) still runs under taint');
  A.eq(await run('echo ok', page), 'ran', 'an ordinary tainted Full Power command is unchanged');
  A.report('shell-taint-hooks.test');
})().catch(e => { console.error(e); process.exit(1); });
