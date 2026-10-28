/* node test/cli.stop-child.test.js — the `starnet` CLI stops the sidecar it spawned GRACEFULLY, on every OS.

   Before: stopChild() went straight to child.kill(). On Windows that is TerminateProcess, so the sidecar's
   gracefulShutdown (reap background jobs, MCP / LSP children, release locks) never ran and those children leaked;
   and the POSIX SIGKILL escalation fired after 2.5s, before the sidecar's own 3s shutdown deadline. Locked here:
     - the CLI spawns the sidecar with an ipc channel and asks for { type: 'starnet.shutdown' } FIRST;
     - a child that honours it exits without ever being killed (proven with a REAL child process);
     - every escalation wait outlasts the sidecar's hard shutdown deadline (read from sidecar/index.js) by >= 0.5s;
     - the order is ask -> SIGTERM -> SIGKILL, and SIGKILL waits the full term grace;
     - the sidecar side actually listens for the message (source check on the require.main block). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const cli = require('../bin/starnet.js');

function fakeChild(o) {
  const c = new EventEmitter();
  c.exitCode = null; c.signalCode = null; c.pid = 999999; c.calls = [];
  c.connected = !!o.ipc;
  c.exit = (code) => { if (c.exitCode !== null) return; c.exitCode = code; c.emit('exit', code); };
  if (o.ipc) c.send = (m) => { c.calls.push({ at: Date.now(), what: 'send:' + (m && m.type) }); if (o.onSend) o.onSend(c); return true; };
  c.kill = (sig) => { c.calls.push({ at: Date.now(), what: 'kill:' + (sig || 'default') }); if (o.onKill) o.onKill(c, sig || 'default'); return true; };
  return c;
}

(async () => {
  // ---- 1. the waits outlast the sidecar's own hard shutdown deadline ----
  {
    const src = readSidecarSource();
    const body = src.slice(src.indexOf('function gracefulShutdown('), src.indexOf('function gracefulShutdown(') + 800);
    const m = /shutdown deadline hit[\s\S]*?process\.exit\(0\);\s*\},\s*(\d+)\)/.exec(body);
    A.ok(!!m, 'the sidecar gracefulShutdown hard deadline is readable from source');
    const deadline = m ? Number(m[1]) : 0;
    A.eq(cli.SIDECAR_SHUTDOWN_DEADLINE_MS, deadline, 'the CLI knows the sidecar\'s real shutdown deadline (' + deadline + 'ms)');
    A.ok(cli.STOP_GRACE_MS >= deadline + 500, 'each escalation wait is >= deadline + 0.5s (' + cli.STOP_GRACE_MS + 'ms; it was 2500)');
    A.ok(cli.STOP_GRACE_MS >= 3500, 'and POSIX SIGKILL waits at least 3.5s');
    // the sidecar listens for the parent's IPC request inside the host-process block
    const hostBlock = src.slice(src.indexOf("process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))"), src.indexOf('/* ---- SSE bridge'));
    A.ok(/process\.on\('message'[\s\S]*starnet\.shutdown[\s\S]*gracefulShutdown\('IPC'\)/.test(hostBlock), 'the sidecar runs gracefulShutdown on { type: "starnet.shutdown" }');
    const cliSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'starnet.js'), 'utf8');
    A.ok(/stdio: \['ignore', 'pipe', 'pipe', 'ipc'\]/.test(cliSrc), 'the CLI spawns the sidecar with an ipc channel');
  }

  // ---- 2. a child that honours the IPC request is never killed ----
  {
    const c = fakeChild({ ipc: true, onSend: (ch) => setTimeout(() => ch.exit(0), 20) });
    await cli.stopChild(c, null, { graceMs: 2000, termMs: 2000, killMs: 200 });
    A.eq(c.calls.map(x => x.what), ['send:starnet.shutdown'], 'asked once over IPC, and never killed');
    A.eq(c.exitCode, 0, 'it exited on its own (the graceful path ran)');
  }

  // ---- 3. escalation order: ask -> SIGTERM -> SIGKILL, each after its full wait ----
  {
    const c = fakeChild({ ipc: true, onKill: (ch, sig) => { if (sig === 'SIGKILL') setTimeout(() => ch.exit(137), 5); } });
    await cli.stopChild(c, null, { graceMs: 120, termMs: 150, killMs: 200 });
    A.eq(c.calls.map(x => x.what), ['send:starnet.shutdown', 'kill:default', 'kill:SIGKILL'], 'ask, then SIGTERM, then SIGKILL');
    A.ok(c.calls[1].at - c.calls[0].at >= 110, 'SIGTERM waited the IPC grace (' + (c.calls[1].at - c.calls[0].at) + 'ms)');
    A.ok(c.calls[2].at - c.calls[1].at >= 140, 'SIGKILL waited the full term grace (' + (c.calls[2].at - c.calls[1].at) + 'ms)');
    const noIpc = fakeChild({ ipc: false, onKill: (ch, sig) => { if (sig === 'default') setTimeout(() => ch.exit(0), 10); } });
    await cli.stopChild(noIpc, null, { graceMs: 100, termMs: 500, killMs: 100 });
    A.eq(noIpc.calls.map(x => x.what), ['kill:default'], 'no ipc channel: SIGTERM, and a child that exits on it is never SIGKILLed');
  }

  // ---- 4. REAL child process: the ipc request reaches it and its cleanup runs (no kill) ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-stopchild-'));
    const marker = path.join(dir, 'graceful.txt');
    const script = "process.on('message', m => { if (m && m.type === 'starnet.shutdown') { require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'reaped'); process.exit(0); } });"
      + "if (process.channel && process.channel.unref) process.channel.unref(); setInterval(() => {}, 1000);";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    await new Promise(r => setTimeout(r, 300));
    const killed = [];
    const realKill = child.kill.bind(child);
    child.kill = (sig) => { killed.push(sig || 'default'); return realKill(sig); };
    const t0 = Date.now();
    await cli.stopChild(child, null);
    A.eq(killed, [], 'the real child was never killed');
    A.ok(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'reaped', 'its graceful cleanup ran (it would not under TerminateProcess)');
    A.eq(child.exitCode, 0, 'it exited 0 on its own');
    A.ok(Date.now() - t0 < 3000, 'promptly (' + (Date.now() - t0) + 'ms)');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('cli.stop-child.test');
})().catch(e => { console.log('FAIL: cli.stop-child.test threw — ' + (e && e.stack || e)); process.exit(1); });
