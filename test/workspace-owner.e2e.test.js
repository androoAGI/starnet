/* node test/workspace-owner.e2e.test.js — the real host refuses a second writer before state load,
   then reclaims an uncatchably killed holder without touching canonical user data. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(e => e ? reject(e) : resolve(port));
    });
  });
}

function start(workspaces, port, extraEnv) {
  const child = spawn(process.execPath, [INDEX], {
    env: Object.assign({}, process.env, {
      SKYNET_WORKSPACES: workspaces,
      SKYNET_PORT: String(port),
      SKYNET_LIVE_PRICES: '0',
      SKYNET_QUEST_REFRESH: '0',
      SKYNET_CRON: '0',
      SKYNET_OPENROUTER_KEY: '',
      STARNET_OPENROUTER_KEY: ''
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  return { child, output: () => output };
}

const diesFirst = (proc, output) => new Promise((_, reject) => proc.once('close', code => reject(new Error('sidecar exited before it was up (' + code + '):\n' + output()))));   // a sidecar that dies at boot fails now, with its output, not at the limit
function waitFor(ready, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const tick = () => {
      const value = ready();
      if (value) return resolve(value);
      if (Date.now() - began >= timeoutMs) return reject(new Error(typeof message === 'function' ? message() : message));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitExit(child, timeoutMs, output) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timeout' + (output ? ':\n' + output() : ''))), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-owner-e2e-'));
  const sentinel = path.join(root, 'canonical-user-state.json');
  const sentinelBytes = JSON.stringify({ agents: 4, workstreams: 33, marker: 'must-survive-collision' });
  fs.writeFileSync(sentinel, sentinelBytes);
  const processes = [];
  try {
    const fakeAppData = path.join(root, 'fake-app-data');
    const protectedRoot = path.join(fakeAppData, 'ai.skynet.harness', 'workspaces');
    fs.mkdirSync(protectedRoot, { recursive: true });
    const protectedSentinel = path.join(protectedRoot, 'real-user-state.json');
    fs.writeFileSync(protectedSentinel, sentinelBytes);
    const protectedPort = await freePort();
    const dev = start(protectedRoot, protectedPort, {
      LOCALAPPDATA: fakeAppData, APPDATA: fakeAppData, SKYNET_DEV: '1', STARNET_DEV: '1'
    });
    processes.push(dev.child);
    const devRefused = await waitExit(dev.child, 30000, dev.output);
    A.eq(devRefused.code, 74, 'DEV/QA host cannot target a canonical user root');
    A.ok(dev.output().includes('DEV_WORKSPACE_PROTECTED'), 'DEV refusal reports the stable safety code');
    A.eq(fs.readFileSync(protectedSentinel, 'utf8'), sentinelBytes, 'DEV refusal happens before user-state mutation');

    const portA = await freePort();
    const portB = await freePort();
    const a = start(root, portA); processes.push(a.child);
    await Promise.race([waitFor(() => a.output().includes('http://127.0.0.1:' + portA), 30000,
      () => 'first sidecar did not boot:\n' + a.output()), diesFirst(a.child, a.output)]);

    const lockfile = path.join(root, '.starnet-workspace-owner.json');
    A.eq(JSON.parse(fs.readFileSync(lockfile, 'utf8')).pid, a.child.pid, 'real host claims WORKSPACES before serving');

    const b = start(root, portB); processes.push(b.child);
    const refused = await waitExit(b.child, 30000, b.output);
    A.eq(refused.code, 73, 'second real host exits with the workspace-safety status');
    A.ok(b.output().includes('WORKSPACE_BUSY'), 'refusal reports the stable collision code');
    A.eq(fs.readFileSync(sentinel, 'utf8'), sentinelBytes, 'refused host cannot mutate canonical state');

    // On Windows this is TerminateProcess (uncatchable); on POSIX SIGKILL gives the same abandoned-claim shape.
    a.child.kill('SIGKILL');
    await waitExit(a.child, 5000);
    const c = start(root, portB); processes.push(c.child);
    await Promise.race([waitFor(() => c.output().includes('http://127.0.0.1:' + portB), 30000,
      () => 'recovery sidecar did not boot:\n' + c.output()), diesFirst(c.child, c.output)]);
    A.eq(JSON.parse(fs.readFileSync(lockfile, 'utf8')).pid, c.child.pid, 'next boot reclaims the proven-dead holder');
    A.eq(fs.readFileSync(sentinel, 'utf8'), sentinelBytes, 'crash recovery preserves canonical state');
    c.child.kill('SIGKILL');
    await waitExit(c.child, 5000);

    A.report('workspace-owner.e2e.test');
  } finally {
    for (const child of processes) {
      try { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); } catch (_) {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
