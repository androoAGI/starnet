/* node test/shell.fg-ledger.test.js — foreground shell.exec children are in the process ledger (h2, F2).

   Before: only background children were recorded, so a sidecar crash in the middle of a foreground command (a
   10-minute test run, a build) left an orphan the next boot's sweep could not know about — the audit's E2E saw the
   shell child orphaned after the force-kill and never swept. Locked here, with a fake spawn and a recording ledger,
   on BOTH routes: environment.js runProcess (the production route index.js wires) and shell.js runCommand:
     - the child is recorded at spawn (kind shell.fg, REDACTED command, pin deferred), marked exited when the root
       exits, and released when the command is over;
     - a command shorter than the pin grace never pays an identity probe; a longer one is pinned once;
     - a root that exits while its stdio stays open keeps its receipt, stamped exited, until stdio closes. The case
       waits for the deferred stamp on timer turns, plain and under a 300 ms loop stall, never on a fixed sleep (R4:
       a 50 ms sleep raced the stamp and went red whenever the box stalled);
     - the shell tool passes the redacted command, never the plaintext secret. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCommand, makeShellTool } = require('../sidecar/tools/builtin/shell.js');
const { makeEnvironmentManager } = require('../sidecar/environment.js');
const { trackChild } = require('../sidecar/procledger.js');
const { stallSoon, waitFor } = require('./helpers/loop-stall.js');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
function mkLedger() {
  const L = { events: [] };
  L.record = (e) => { L.events.push(['record', e.pid, e.kind, e.cmd, e.pin]); return e; };
  L.pinIdentity = async (pid) => { L.events.push(['pin', pid]); return null; };
  L.touch = (pids) => { L.events.push(['touch', pids[0]]); return 1; };
  L.markExited = (pid) => { L.events.push(['exited', pid]); return true; };
  L.release = (pid) => { L.events.push(['release', pid]); };
  return L;
}
function makeFakeSpawn(opts) {
  opts = opts || {};
  const spawn = function (cmd, o) {
    const h = {};
    const child = {
      cmd, opts: o, pid: 4242 + spawn.children.length,
      stdout: { on: (ev, fn) => { if (ev === 'data') child._data = fn; } }, stderr: { on() {} },
      on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }, kill() {}, unref() {},
      _exit: (code) => { (h.exit || []).forEach(f => f(code)); },
      _close: (code) => { (h.close || []).forEach(f => f(code)); }
    };
    spawn.children.push(child);
    // the root exits at runMs and stdio closes with it; with holdClose stdio stays open (a grandchild holding the
    // pipe delays 'close') until the test calls child._close itself
    setTimeout(() => {
      if (child._data) child._data(Buffer.from('hello\n'));
      child._exit(0);
      if (!opts.holdClose) child._close(0);
    }, opts.runMs || 0);
    return child;
  };
  spawn.children = [];
  return spawn;
}

(async () => {
  // ---- 1. shell.js runCommand: record -> release; a fast command is never pinned nor exit-stamped ----
  {
    const L = mkLedger();
    const spawn = makeFakeSpawn({ runMs: 5 });
    const res = await runCommand({ spawn, cmd: 'echo hi', cwd: '.', timeoutMs: 5000, isWin: true, ledger: L, ledgerCmd: 'echo hi', ledgerPinAfterMs: 200 });
    A.eq(res.exitCode, 0, 'the command still runs normally');
    A.eq(L.events.map(e => e[0]), ['record', 'release'], 'recorded at spawn and released when over (two ledger writes, no more)');
    A.eq(L.events[0][1], 4242, 'the receipt is the real child pid');
    A.eq(L.events[0][2], 'shell.fg', 'kind shell.fg');
    A.eq(L.events[0][4], false, 'pinning is deferred (no identity probe per quick command)');
    await delay(250);
    A.ok(!L.events.some(e => e[0] === 'pin'), 'a command that finished inside the grace is never pinned');
  }
  // ---- 1b. the root exits but its stdio stays open (a grandchild holds the pipe): the exit freezes the window ----
  // The stamp is deferred (ledgerExitStampMs 10), so the case waits for it on timer turns. Timers fire in due order,
  // and every poll set after the exit callback is due at least 25 ms after it, past the stamp: the wait is exact
  // under any loop timing. The second run blocks the loop for 300 ms right after the spawn, which a fixed sleep
  // could not survive (R4). Stdio closes only when the test says so, so 'release' cannot come early either.
  for (const stall of [0, 300]) {
    const under = stall ? ' (under a ' + stall + ' ms loop stall)' : '';
    const L = mkLedger();
    const kinds = () => L.events.map(e => e[0]);
    const spawn = makeFakeSpawn({ runMs: 5, holdClose: true });
    const p = runCommand({ spawn, cmd: 'start-server', cwd: '.', timeoutMs: 5000, isWin: true, ledger: L, ledgerCmd: 'start-server', ledgerPinAfterMs: 1000, ledgerExitStampMs: 10 });
    const stalled = stall ? stallSoon(stall) : null;
    const stamped = await waitFor(() => kinds().includes('exited'));
    A.ok(stamped, 'the root exit is stamped while stdio stays open' + under + ' (events ' + JSON.stringify(kinds()) + ')');
    A.eq(kinds(), ['record', 'exited'], 'the lingering command keeps its receipt, stamped with the root exit' + under);
    if (stalled) { const ms = await stalled; A.ok(ms >= 240, 'the stall really blocked the loop (' + ms + ' ms)'); }
    spawn.children[0]._close(0);
    await p;
    A.eq(kinds(), ['record', 'exited', 'release'], 'and is released only when its stdio finally closes' + under);
  }
  // ---- 2. a long command is pinned once, while it is still running ----
  {
    const L = mkLedger();
    const spawn = makeFakeSpawn({ runMs: 120 });
    const p = runCommand({ spawn, cmd: 'npm test', cwd: '.', timeoutMs: 5000, isWin: true, ledger: L, ledgerCmd: 'npm test', ledgerPinAfterMs: 30 });
    await delay(70);
    A.ok(L.events.some(e => e[0] === 'record') && !L.events.some(e => e[0] === 'release'), 'while it runs, the receipt is held');
    A.eq(L.events.filter(e => e[0] === 'pin').length, 1, 'a command that outlives the grace is pinned exactly once');
    await p;
    A.eq(L.events[L.events.length - 1][0], 'release', 'and released when it finishes');
  }
  // ---- 3. no ledger -> byte-identical behavior (every existing caller) ----
  {
    const spawn = makeFakeSpawn({ runMs: 1 });
    const res = await runCommand({ spawn, cmd: 'echo hi', cwd: '.', timeoutMs: 5000, isWin: true });
    A.eq(res.exitCode, 0, 'no ledger: the command runs exactly as before');
  }
  // ---- 4. the PRODUCTION route: environment.js local execute (what index.js wires ahead of runCommand) ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-fg-ledger-'));
  try {
    const L = mkLedger();
    const spawn = makeFakeSpawn({ runMs: 5 });
    const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, clock: { now: () => 0 }, env: {}, config: { backend: 'local' }, ledger: L,
      redact: (s) => String(s).replace(/sk-live-[a-z0-9]+/g, '[REDACTED]') });
    const res = await env.execute({ agentId: 'a', cmd: 'curl -H "Authorization: Bearer sk-live-abc123" http://x', timeoutMs: 5000 });
    A.eq(res.exitCode, 0, 'the environment route runs normally');
    A.eq(L.events.map(e => e[0]), ['record', 'release'], 'the production route records and releases the foreground child');
    A.ok(L.events[0][3].indexOf('sk-live-abc123') < 0, 'the ledger receives only the REDACTED command');

    // and the shell TOOL on that route hands the redacted command (not the marker-wrapped plaintext) to the ledger
    const L2 = mkLedger();
    const spawn2 = makeFakeSpawn({ runMs: 5 });
    const env2 = makeEnvironmentManager({ spawn: spawn2, fs, pathMod: path, root, clock: { now: () => 0 }, env: {}, config: { backend: 'local' }, ledger: L2 });
    const tools = makeShellTool({ environment: env2, fs, pathMod: path, root, clock: { now: () => 0 }, platform: 'win32',
      redact: (s) => String(s).replace(/sk-live-[a-z0-9]+/g, '[REDACTED]') });
    await tools.execTool.run({ cmd: 'echo sk-live-zzz999' }, { agentId: 'a' });
    const rec = L2.events.find(e => e[0] === 'record');
    A.ok(rec && rec[3] === 'echo [REDACTED]', 'the tool passes the redacted user command to the ledger (' + (rec && rec[3]) + ')');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }

  // ---- 5. trackChild contract: inert without a ledger / pid; exited() is idempotent and stops the pin ----
  {
    const t = trackChild(null, 123, {}); t.exited(); t.done();
    A.ok(true, 'no ledger: trackChild is inert');
    const L = mkLedger();
    const t2 = trackChild(L, 77, { cmd: 'x', pinAfterMs: 20, exitStampMs: 0 });
    t2.exited(); t2.exited();
    await delay(40);
    A.eq(L.events.map(e => e[0]), ['record', 'exited'], 'exited once, and a root that already exited is never pinned');
    t2.done(); t2.done();
    A.eq(L.events.filter(e => e[0] === 'release').length, 1, 'released once');
  }

  // ---- 6. the DEFERRED exit stamp carries the instant the exit was observed, not the (later) write time ----
  {
    const { makeProcLedger } = require('../sidecar/procledger.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgledger-'));
    try {
      let t = 100000;
      const ledger = makeProcLedger({ fs, pathMod: path, file: path.join(dir, 'proc-ledger.json'), clock: { now: () => t }, isWin: false,
        probe: async () => null, killTree: async () => ({ ok: true }) });
      const tr = trackChild(ledger, 5151, { cmd: 'npm test', pinAfterMs: 100000, exitStampMs: 30 });
      t = 200000; tr.exited();     // the root exits at t=200000
      t = 201000;                  // …and the deferred stamp is written ~1s later
      await delay(60);
      const e = ledger.list().find(r => r.pid === 5151);
      A.ok(e && e.exited, 'the receipt is marked exited');
      A.eq(e && e.exitedAt, 200000, 'exitedAt is the observed exit instant (it used to be stamped at write time, 1s late)');
      tr.done();
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }

  A.report('shell.fg-ledger.test');
})().catch(e => { console.log('FAIL: shell.fg-ledger.test threw — ' + (e && e.stack || e)); process.exit(1); });
