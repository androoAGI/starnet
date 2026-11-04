/* node test/shell-bg.test.js — background shell process manager (H2.2).
   Proves the lifecycle with an injected fake spawn (no real processes): start returns a handle without blocking,
   status reports running + streams output into a bounded tail, a natural close fires shell.bg.exit (via onExit),
   the per-agent cap refuses excess, kill reaps a running child + reports killed on exit, killAll reaps, and
   procs are agent-scoped. Deterministic (injected clock); isWin:true so kill uses taskkill (no real process.kill). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeShellBg } = require('../sidecar/shellbg.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

// a fake spawn: each child exposes _emit(data) and _close(code) so the test drives the lifecycle by hand.
function makeFakeSpawn() {
  const spawn = function (cmd, argsOrOpts, maybeOpts) {
    const args = Array.isArray(argsOrOpts) ? argsOrOpts : null;
    const opts = args ? (maybeOpts || {}) : (argsOrOpts || {});
    if (cmd === 'taskkill') {
      spawn.taskkills++;
      spawn.order.push('taskkill');
      // h2: kill() now waits for taskkill's verdict — answer it (exit 0) and let the named root close, as the OS would
      const h = {};
      setImmediate(() => {
        const target = spawn.children.find(c => String(c.pid) === String(argsOrOpts[1]));
        if (target) target._close(1);
        if (h.close) h.close(0);
      });
      return { pid: 0, on(ev, fn) { h[ev] = fn; }, unref() {}, stdout: { on() {} }, stderr: { on() {} } };
    }
    let dataCb = null, closeCb = null, errCb = null;
    const child = {
      cmd, args, opts, pid: 1000 + spawn.children.length, killed: false, unrefed: false,
      stdout: { on: (ev, fn) => { if (ev === 'data') dataCb = fn; } },
      stderr: { on: () => {} },
      on: (ev, fn) => { if (ev === 'close') closeCb = fn; else if (ev === 'error') errCb = fn; },
      unref: function () { this.unrefed = true; },
      kill: function () { this.killed = true; spawn.order.push('child.kill'); },
      _emit: (s) => { if (dataCb) dataCb(Buffer.from(String(s))); },
      _close: (code) => { if (closeCb) closeCb(code); },
      _err: () => { if (errCb) errCb(new Error('spawn err')); }
    };
    spawn.children.push(child);
    return child;
  };
  spawn.children = []; spawn.taskkills = 0; spawn.order = [];
  return spawn;
}

let T = 1000; const clock = { now: () => T };

// ---- argv-form backend children never cross a host shell parser ----
{
  const spawn = makeFakeSpawn();
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true });
  const started = bg.start({
    agentId: 'docker', cmd: 'printf "$VALUE"', cwd: '/host/workspace',
    file: 'dockerx', args: ['exec', '-i', 'owned-container', 'sh', '-lc', 'printf "$VALUE"'],
    env: { VALUE: 'safe' }
  });
  A.ok(started.ok, 'argv-form backend background process starts');
  A.eq(spawn.children[0].cmd, 'dockerx', 'backend executable is passed separately');
  A.eq(spawn.children[0].args[0], 'exec', 'backend argv is preserved');
  A.eq(spawn.children[0].opts.shell, false, 'backend child never crosses a host shell parser');
  A.eq(spawn.children[0].opts.env.VALUE, 'safe', 'backend child receives its explicit client environment');
}

// ---- start / status / streaming / natural exit ----
{
  const spawn = makeFakeSpawn();
  const exits = [];
  let full = '';
  const bg = makeShellBg({ spawn, clock, onExit: (e) => exits.push(e), maxPerAgent: 2, isWin: true,
    spill: e => { full += e.text; return { path: '.output/shell-bg-' + e.id + '.txt', bytes: Buffer.byteLength(full) }; } });

  T = 1000;
  const s1 = bg.start({ agentId: 'a', cmd: 'npm run dev', cwd: '/ws/a' });
  A.ok(s1.ok && s1.bgId === 'bg_1', 'start returns a handle immediately (non-blocking)');
  A.eq(bg.count('a'), 1, 'one running process');
  A.ok(spawn.children[0].unrefed, 'the child is unref\'d (never blocks sidecar exit)');
  let st = bg.status('a', 'bg_1');
  A.ok(st && st.running && st.exitCode === null, 'status reports running');
  A.eq(st.pid, spawn.children[0].pid, 'status exposes the owned root PID for localhost listener attestation');

  spawn.children[0]._emit('Server listening on :3000\n');
  A.ok(bg.status('a', 'bg_1').tail.indexOf('listening on :3000') >= 0, 'stdout streams into the status tail');
  A.eq(full, 'Server listening on :3000\n', 'background output is appended whole to the durable spill seam');
  A.eq(bg.status('a', 'bg_1').outputPath, '.output/shell-bg-bg_1.txt', 'status exposes the exact recoverable log path');
  A.eq(bg.status('a', 'bg_1').outputSpillVerified, true, 'status distinguishes a verified spill from a bounded memory tail');

  // cap: a 2nd is fine, a 3rd is refused
  A.ok(bg.start({ agentId: 'a', cmd: 'sleep 99' }).ok, 'second within cap');
  const over = bg.start({ agentId: 'a', cmd: 'sleep 99' });
  A.ok(!over.ok && /too many/.test(over.error), 'over the per-agent cap -> refused');

  // natural exit -> shell.bg.exit
  T = 5200;
  spawn.children[0]._close(0);
  A.eq(exits.length, 1, 'one shell.bg.exit fired on close');
  A.eq(exits[0].bgId, 'bg_1', 'exit names the process'); A.eq(exits[0].exitCode, 0, 'exit code captured');
  A.eq(exits[0].killed, false, 'a natural exit is not "killed"'); A.eq(exits[0].ms, 4200, 'elapsed ms from the injected clock');
  A.ok(!bg.status('a', 'bg_1').running, 'status now reports not-running'); A.eq(bg.count('a'), 1, 'running count drops');
}

// ---- kill reaps a running child and reports killed on its (simulated) close ----
// h2: kill() is async and answers only with proof (test/shellbg.kill-verified.test.js holds the full contract).
const killBlock = (async () => {
  const spawn = makeFakeSpawn();
  const exits = [];
  const bg = makeShellBg({ spawn, clock, onExit: (e) => exits.push(e), maxPerAgent: 5, isWin: true });
  bg.start({ agentId: 'a', cmd: 'sleep 99' });   // bg_1
  const k = bg.kill('a', 'bg_1');
  A.eq(spawn.order, ['taskkill'], 'Windows asks taskkill /T to discover the live tree BEFORE killing its root');
  A.ok(!spawn.children[0].killed, 'the direct child kill does not race taskkill tree discovery');
  spawn.children[0]._close(137);   // the OS reaps it after the kill
  A.eq(exits[0].killed, true, 'a killed process reports killed:true on exit');
  const kr = await k;
  A.eq(kr.ok, false, 'without a process table the kill is not claimed as done (it was ok the instant taskkill launched)');
  A.eq(!!(kr.unverified && kr.rootExited), true, 'it says what it knows: the root exited, the tree is unverified');
  A.ok(!(await bg.kill('a', 'nope')).ok, 'killing an unknown id -> not ok');
})();

// ---- a post-spawn error is not process-exit truth; only close releases the cleanup receipt ----
{
  const spawn = makeFakeSpawn();
  const released = [];
  const bg = makeShellBg({
    spawn, clock, maxPerAgent: 5, isWin: true,
    ledger: { record() {}, pinIdentity: async () => {}, release: pid => released.push(pid) }
  });
  bg.start({ agentId: 'a', cmd: 'sleep 99' });
  spawn.children[0]._err();
  A.eq(bg.status('a', 'bg_1').running, true, 'a post-spawn child error does not pretend the process exited');
  A.eq(released.length, 0, 'a post-spawn child error retains the durable cleanup receipt');
  spawn.children[0]._close(1);
  A.eq(bg.status('a', 'bg_1').running, false, 'the close event settles the process lifecycle');
  A.eq(released, [spawn.children[0].pid], 'close releases the cleanup receipt exactly once');
}

// ---- Windows reaper launch failure falls back to the direct child ----
const reaperBlock = (async () => {
  const baseSpawn = makeFakeSpawn();
  const spawn = function (cmd, opts) {
    if (cmd === 'taskkill') throw new Error('taskkill unavailable');
    return baseSpawn(cmd, opts);
  };
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true, killVerify: { attempts: 2, pollMs: 0 } });
  bg.start({ agentId: 'a', cmd: 'sleep 99' });
  const r = await bg.kill('a', 'bg_1');
  A.ok(baseSpawn.children[0].killed, 'taskkill launch failure falls back to direct child.kill');
  A.eq(r.ok, false, 'a kill whose reaper could not even start is NOT reported as done (it used to be "accepted")');
})();

// ---- redacted command + exact OS identity pin ----
{
  const spawn = makeFakeSpawn();
  const ledgerCalls = { records: [], pins: [] };
  const ledger = {
    record: (entry) => ledgerCalls.records.push(entry),
    pinIdentity: async (pid) => { ledgerCalls.pins.push(pid); },
    release: () => {}
  };
  const bg = makeShellBg({
    spawn, clock, maxPerAgent: 5, isWin: true, ledger,
    redact: (s) => String(s).replace(/super-secret-value/g, '[REDACTED]')
  });
  bg.start({ agentId: 'secret', cmd: 'curl -H "Authorization: Bearer super-secret-value" http://127.0.0.1' });
  A.eq(ledgerCalls.records.length, 1, 'background child is recorded in the persistent ledger');
  A.ok(ledgerCalls.records[0].cmd.indexOf('super-secret-value') < 0, 'ledger record receives only the redacted command');
  A.eq(ledgerCalls.pins.join(','), String(spawn.children[0].pid), 'background child asks the ledger to pin exact OS identity after spawn');
}

// ---- agent isolation + killAll ----
{
  const spawn = makeFakeSpawn();
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true });
  bg.start({ agentId: 'a', cmd: 'x' });
  bg.start({ agentId: 'b', cmd: 'y' });
  A.eq(bg.status('a').length, 1, 'agent a sees only its own process');
  A.eq(bg.status('b', bg.status('b')[0].bgId).bgId !== undefined, true, 'agent b sees its own');
  A.eq(bg.status('a', bg.status('b')[0].bgId), null, 'agent a cannot see agent b\'s process by id (isolation)');
  A.eq(bg.killAll('a'), 1, 'killAll(agent) reaps only that agent\'s running procs');
  A.eq(bg.count('a'), 0, 'a has none running'); A.eq(bg.count('b'), 1, 'b untouched');
  A.eq(bg.killAll(), 1, 'killAll() reaps everything remaining');
}

// ---- the shell TOOLS delegate to the manager (background:true + shell.bg.status/kill) ----
(async () => {
  await killBlock; await reaperBlock;
  const spawn = makeFakeSpawn();
  // a process table that shows no owned descendants: the kill below can be CONFIRMED (h2 F3)
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true, processTable: async () => [{ pid: 1, ppid: 0, created: 1 }] });
  const fs = { mkdirSync: function () {}, existsSync: function () { return true; } };
  const ctx = { agentId: 'a' };

  /* A background start is screened like a foreground one, and on Windows a bare program is proven before anything starts (a21bc3e84,
     the bare-name proof): `npm` is searched for the way cmd searches, from an absolute known folder, and must be a readable batch shim
     or a console program. This fixture's relative root and stub file system (no stat, no read) can prove nothing, so `npm run dev`
     there is refused at shell.exec, before the manager is asked, and that is the behaviour pinned here. It is not the refusal of text
     typed into a running process (shell.bg.write, terminal.write), which has its own tests. */
  {
    const unprovable = makeShellTool({ spawn, fs, pathMod: path, root: path.join('root'), clock, bg, platform: 'win32' });
    let refusal = '';
    try { await unprovable.execTool.run({ cmd: 'npm run dev', background: true }, ctx); } catch (e) { refusal = String((e && e.message) || e); }
    A.ok(/refused \[user-control\]/.test(refusal) && /could not confirm/.test(refusal), 'a bare program the fixture cannot prove is refused at shell.exec, background or not');
    A.eq(bg.count('a'), 0, 'and it never reached the background manager');
    A.eq(spawn.children.length, 0, 'nor any spawn');
  }

  // A real workspace gives the guard what it asks for: an absolute folder, a file system it can read, and the program on PATH.
  const nodeFs = require('fs'), os = require('os');
  const ws = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shell-bg-'));
  try {
    const bin = path.join(ws, 'bin');
    nodeFs.mkdirSync(bin);
    nodeFs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo dev server\r\n');
    const tools = makeShellTool({ spawn, fs: nodeFs, pathMod: path, root: path.join(ws, 'agents'), clock, bg, platform: 'win32', env: { PATH: bin, PATHEXT: '.cmd;.exe' } });

    const r = await tools.execTool.run({ cmd: 'npm run dev', background: true }, ctx);
    A.ok(/Started background process bg_/.test(r.content), 'shell.exec background:true starts a bg process via the manager');
    A.eq(bg.count('a'), 1, 'the manager tracks the backgrounded process');

    const st = await tools.bgStatusTool.run({}, ctx);
    A.ok(/RUNNING/.test(st.content) && /bg_1/.test(st.content), 'shell.bg.status lists it running');

    const k = await tools.bgKillTool.run({ id: 'bg_1' }, ctx);
    A.ok(/Killed/.test(k.content), 'shell.bg.kill stops it');
    A.eq(bg.count('a'), 0, 'the slot is freed after kill');
  } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }

  const asyncEnvironment = {
    backendId: 'docker',
    ensureWorkspace: () => '/host/a', getCwd: () => '/workspace', workspaceRoot: () => '/host/a',
    startBackground: () => Promise.resolve({ ok: true, bgId: 'bg_remote' })
  };
  const asyncTools = makeShellTool({ environment: asyncEnvironment, fs, pathMod: path, root: path.join('root'), clock, platform: 'win32' });
  const remote = await asyncTools.execTool.run({ cmd: 'node server.js', background: true }, ctx);
  A.ok(/Started background process bg_remote/.test(remote.content), 'shell tool awaits an async persistent-backend startup');

  // a docker/ssh kill is never reported as a confirmed tree kill: the host-side proof covers only the exec client
  for (const backendId of ['docker', 'ssh']) {
    const env = Object.assign({}, asyncEnvironment, { backendId,
      killBackground: () => Promise.resolve({ ok: true, verified: true, bgId: 'bg_remote', killedPids: [11, 12] }) });
    const t = makeShellTool({ environment: env, fs, pathMod: path, root: path.join('root'), clock, platform: 'win32' });
    const kr = await t.bgKillTool.run({ id: 'bg_remote' }, ctx);
    A.ok(!/confirmed gone\./.test(kr.content) && !/^Killed/.test(kr.content), backendId + ': the kill does not claim the whole tree is confirmed gone');
    A.ok(/unverified/.test(kr.content) && new RegExp(backendId).test(kr.content), backendId + ': it says the kill went through the backend and is unverified');
    A.eq(kr.summary, 'kill unconfirmed', backendId + ': honest summary');
  }
  {
    const env = Object.assign({}, asyncEnvironment, { backendId: 'local',
      killBackground: () => Promise.resolve({ ok: true, verified: true, bgId: 'bg_l', killedPids: [11, 12] }) });
    const t = makeShellTool({ environment: env, fs, pathMod: path, root: path.join('root'), clock, platform: 'win32' });
    const kr = await t.bgKillTool.run({ id: 'bg_l' }, ctx);
    A.ok(/confirmed gone/.test(kr.content) && kr.summary === 'killed', 'the local backend keeps its proven wording');
  }

  A.report('shell-bg.test');
})().catch(function (e) { console.error(e); process.exit(1); });
