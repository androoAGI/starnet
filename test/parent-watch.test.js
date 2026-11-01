'use strict';
/* node test/parent-watch.test.js — a station never outlives its owner (sidecar/parent-watch.js).

   A hard-killed owner (the desktop shell, the `starnet` terminal) runs none of its stop code, so its station used to
   keep running as an orphan holding the workspace claim (#31). The station now watches its owner and shuts itself down
   gracefully when the owner is gone. Proven here:
     1. the decision, with fakes: re-parented (POSIX) = gone; ESRCH = gone; EPERM / any other error = alive; an inherited
        STARNET_PARENT_PID that is not this process's parent is ignored and says so; nothing named and no ipc = inert;
        an ipc disconnect = gone; it fires once and stops its timer.
     2. REAL processes: an owner process starts a DETACHED child (outside any job the owner holds, so only the watch can
        end it), the test hard-kills the owner (TerminateProcess / SIGKILL), and the child notices and exits — once for
        the PID watch (STARNET_PARENT_PID, the desktop shell's way) and once for the ipc watch (the terminal's way).
     3. sidecar/index.js starts the watch in its host-process block and answers it with gracefulShutdown. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const A = require('./_assert.js');
const { readSidecarSource } = require('./helpers/source');
const { makeParentWatch, envParentPid } = require('../sidecar/parent-watch.js');

function fakeProc(o) {
  const p = new EventEmitter();
  p.ppid = o.ppid; p.platform = o.platform || 'linux'; p.env = o.env || {};
  p.kill = (pid, sig) => { p.killed = (p.killed || []).concat([[pid, sig]]); if (o.killError) { const e = new Error(o.killError); e.code = o.killError; throw e; } return true; };
  if (o.ipc) p.send = () => true;
  return p;
}
function fakeTimers() {
  const t = { fns: [], cleared: 0 };
  t.setInterval = (fn) => { t.fns.push(fn); return { unref() { t.unrefd = true; } }; };
  t.clearInterval = () => { t.cleared++; };
  t.tick = () => t.fns.forEach(fn => fn());
  return t;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }

(async () => {
  // ---- 1. the decision ----
  A.eq(envParentPid({ STARNET_PARENT_PID: ' 4242 ' }), 4242, 'STARNET_PARENT_PID names the owner');
  A.eq(envParentPid({ SKYNET_PARENT_PID: '77' }), 77, 'the legacy spelling too');
  A.eq(envParentPid({ STARNET_PARENT_PID: 'x' }), 0, 'junk names nobody');
  {
    const gone = [];
    const t = fakeTimers();
    const proc = fakeProc({ ppid: 4242, env: { STARNET_PARENT_PID: '4242' } });
    const w = makeParentWatch({ proc, setInterval: t.setInterval, clearInterval: t.clearInterval, onGone: r => gone.push(r) });
    A.eq(w.start(), { watching: ['pid 4242'] }, 'the named parent is watched');
    A.ok(t.unrefd, 'the watch timer never keeps the station alive');
    t.tick();
    A.eq(gone, [], 'a live owner: nothing happens');
    proc.ppid = 1;
    t.tick();
    A.eq(gone.length, 1, 'POSIX: re-parented away from the owner = the owner is gone');
    A.ok(/pid 4242\) is gone/.test(gone[0]) && /re-parented to pid 1/.test(gone[0]), 'and it says so: ' + gone[0]);
    A.eq(t.cleared, 1, 'the timer stops after firing');
    t.tick();
    A.eq(gone.length, 1, 'it fires once');
  }
  {
    const gone = [];
    const t = fakeTimers();
    const proc = fakeProc({ ppid: 4242, platform: 'win32', env: { STARNET_PARENT_PID: '4242' }, killError: 'ESRCH' });
    const w = makeParentWatch({ proc, setInterval: t.setInterval, clearInterval: t.clearInterval, onGone: r => gone.push(r) });
    w.start();
    A.eq(proc.killed, undefined, 'start probes nothing');
    t.tick();
    A.eq(gone.length, 1, 'ESRCH = the owner is gone');
    A.eq(proc.killed[0], [4242, 0], 'probed with signal 0, never a real signal');
  }
  {
    const gone = [];
    const t = fakeTimers();
    const proc = fakeProc({ ppid: 4242, platform: 'win32', env: { STARNET_PARENT_PID: '4242' }, killError: 'EPERM' });
    makeParentWatch({ proc, setInterval: t.setInterval, clearInterval: t.clearInterval, onGone: r => gone.push(r) }).start();
    t.tick(); t.tick();
    A.eq(gone, [], 'EPERM is a live owner: a watch that cannot prove the owner gone never stops the station');
  }
  {
    const t = fakeTimers();
    const proc = fakeProc({ ppid: 5000, env: { STARNET_PARENT_PID: '4242' } });
    const r = makeParentWatch({ proc, setInterval: t.setInterval, clearInterval: t.clearInterval }).start();
    A.eq(r.watching, [], 'an inherited STARNET_PARENT_PID that is not this process\'s parent is not watched');
    A.ok(/does not name this station's parent \(pid 5000\)/.test(r.ignored || ''), 'and it says why: ' + r.ignored);
    A.eq(t.fns.length, 0, 'no timer');
  }
  {
    const t = fakeTimers();
    const r = makeParentWatch({ proc: fakeProc({ ppid: 5000 }), setInterval: t.setInterval, clearInterval: t.clearInterval }).start();
    A.eq(r, { watching: [] }, 'no owner named and no ipc channel (npm start, a test harness): inert');
  }
  {
    const gone = [];
    const proc = fakeProc({ ppid: 5000, ipc: true });
    const w = makeParentWatch({ proc, onGone: r => gone.push(r) });
    A.eq(w.start(), { watching: ['ipc'] }, 'a station spawned with an ipc channel watches it');
    proc.emit('disconnect');
    A.eq(gone.length, 1, 'the channel closing = the terminal is gone');
    A.ok(/ipc channel closed/.test(gone[0]), gone[0]);
    proc.emit('disconnect');
    A.eq(gone.length, 1, 'once');
    A.eq(proc.listenerCount('disconnect'), 0, 'the listener is removed');
  }

  // ---- 2. REAL processes: hard-kill the owner, the detached child leaves on its own ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-parent-watch-'));
  const started = [];
  try {
    const watchPath = path.resolve(__dirname, '..', 'sidecar', 'parent-watch.js');
    fs.writeFileSync(path.join(dir, 'child.js'), [
      "const fs = require('fs');",
      'const out = process.argv[2];',
      'const w = require(' + JSON.stringify(watchPath) + ').makeParentWatch({ intervalMs: 150, onGone: (why) => { fs.writeFileSync(out, why); process.exit(0); } });',
      "fs.writeFileSync(out + '.started', JSON.stringify(w.start()));",
      'setInterval(function () {}, 1000);'
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'owner.js'), [
      "const { spawn } = require('child_process');",
      "const mode = process.argv[2], out = process.argv[3];",
      "const env = Object.assign({}, process.env);",
      "delete env.STARNET_PARENT_PID; delete env.SKYNET_PARENT_PID;",
      "if (mode === 'pid') env.STARNET_PARENT_PID = String(process.pid);",
      "const stdio = mode === 'ipc' ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore';",
      "const c = spawn(process.execPath, [require('path').join(__dirname, 'child.js'), out], { detached: true, stdio, env, windowsHide: true });",
      "if (c.channel && c.channel.unref) c.channel.unref();",
      "process.stdout.write(String(c.pid) + '\\n');",
      'setInterval(function () {}, 1000);'
    ].join('\n'));
    for (const mode of ['pid', 'ipc']) {
      const out = path.join(dir, mode + '.out');
      const owner = spawn(process.execPath, [path.join(dir, 'owner.js'), mode, out], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const childPid = await new Promise(resolve => { owner.stdout.once('data', d => resolve(Number(String(d).trim()))); setTimeout(() => resolve(0), 10000); });
      A.ok(childPid > 0, mode + ': the owner started its detached child');
      if (childPid > 0) started.push(childPid);
      for (let i = 0; i < 50 && !fs.existsSync(out + '.started'); i++) await sleep(100);
      const watching = fs.existsSync(out + '.started') ? JSON.parse(fs.readFileSync(out + '.started', 'utf8')).watching : null;
      A.eq(watching, mode === 'pid' ? ['pid ' + owner.pid] : ['ipc'], mode + ': the child watches its owner');
      await sleep(500);
      A.ok(alive(childPid) && !fs.existsSync(out), mode + ': while the owner lives, the child runs');
      owner.kill('SIGKILL');   // Windows: TerminateProcess — no handler in the owner runs
      for (let i = 0; i < 60 && !fs.existsSync(out); i++) await sleep(100);
      A.ok(fs.existsSync(out), mode + ': the child noticed its owner was hard-killed');
      if (fs.existsSync(out)) A.ok(/is gone/.test(fs.readFileSync(out, 'utf8')), mode + ': with the reason: ' + fs.readFileSync(out, 'utf8'));
      for (let i = 0; i < 30 && alive(childPid); i++) await sleep(100);
      A.ok(!alive(childPid), mode + ': and exited (no orphan)');
    }
  } finally {
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- 3. the station starts the watch and answers it with its graceful shutdown ----
  {
    const src = readSidecarSource();
    const from = src.indexOf("process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))");
    const hostBlock = from >= 0 ? src.slice(from, src.indexOf('/* ---- SSE bridge', from)) : '';
    A.ok(hostBlock.length > 0, 'the host-process block is found');
    A.ok(/require\('\.\/parent-watch\.js'\)\.makeParentWatch\(\{[\s\S]*?onGone:[\s\S]*?gracefulShutdown\('parent-gone'\)[\s\S]*?\}\)\.start\(\)/.test(hostBlock),
      'sidecar/index.js starts the parent watch in its host-process block and answers it with gracefulShutdown');
  }

  A.report('parent-watch.test');
})().catch(e => { console.error(e); process.exit(1); });
