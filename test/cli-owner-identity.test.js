'use strict';
/* node test/cli-owner-identity.test.js — `starnet` reads the desktop station's owner claim the way the station does,
   and never deletes it.

   1. A RECYCLED PID is not the station. A hard-killed station leaves its workspace-owner claim behind, and Windows
      recycles PIDs within one boot: the claim can name a PID some unrelated program holds now. `starnet` read that
      PID as "alive", could not find a port for it, and refused ("the desktop app owns the default workspace (pid …)
      but its port could not be discovered") until a reboot. It now judges the claim with sidecar/process-identity.js
      (judgeReuse, the rule the station's own boot uses): a claim stamped an hour before the process now holding its
      PID was created is a dead station, so `starnet` takes the app-closed path. Proven with the REAL bin/starnet.js
      against a scratch profile, the claim naming THIS test process's own PID.
   2. A claim that process could have written (stamped after it was created) still names a live owner: refused as
      before. Uncertainty never authorizes a second station.
   3. stopChild never deletes the owner claim, not even for the dead child it spawned: the station's next boot
      reclaims it under its election ticket, and an unlink from outside raced that protocol (a station that reclaimed
      the workspace in between lost its live claim).
   4. Cheapest first: a claim stamped before this computer last started is dead before any PID check (the station's
      own boot rule, shared through sidecar/process-identity.js predatesBoot); a live owner the OS shows LISTENING is
      attached to with NO identity probe (a PowerShell / ps call — seconds on every `starnet` while the app runs);
      only a live PID with no port — the case that refused — is probed. */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const A = require('./_assert.js');

const BIN = path.resolve(__dirname, '..', 'bin', 'starnet.js');

function portAnswers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
function cli(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.on('exit', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
const tail = s => s.trim().split('\n').slice(-3).join(' | ');

(async () => {
  // ---- 3. stopChild never deletes the claim (no process needed) ----
  {
    const cli3 = require('../bin/starnet.js');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-claim-keep-'));
    try {
      const lock = path.join(ws, '.starnet-workspace-owner.json');
      const claim = JSON.stringify({ version: 1, pid: 999999, nonce: 'dead-child', startedAt: 1 });
      fs.writeFileSync(lock, claim);
      const child = new EventEmitter();
      child.pid = 999999; child.exitCode = 1; child.signalCode = null;   // our child, already dead (TerminateProcess)
      await cli3.stopChild(child, ws);
      A.ok(fs.existsSync(lock), 'stopChild leaves the dead child\'s owner claim for the station\'s own reclaim');
      A.eq(fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null, claim, 'byte for byte');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // ---- 4. the claim is judged cheapest first: the identity probe runs only where it decides anything ----
  {
    const { discoverDesktop } = require('../bin/starnet.js');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-claim-order-'));
    try {
      fs.writeFileSync(path.join(ws, '.starnet-workspace-owner.json'), JSON.stringify({ version: 1, pid: 4242, nonce: 'n', startedAt: 9000000000000 }));
      const probes = [];
      const verdict = v => (claim, pid) => { probes.push(pid); return v; };
      // a live owner LISTENING on a port is a station to attach to: no identity probe (it is a PowerShell / ps call)
      const listening = discoverDesktop(ws, { pidAlive: () => true, listeningPortOf: () => 51234, claimVerdict: verdict('reused'), bootedAt: () => 1 });
      A.eq([listening.ownerAlive, listening.port, listening.source], [true, 51234, 'os'], 'a listening owner is attached to');
      A.eq(probes.length, 0, 'and its identity is never probed (no PowerShell per `starnet` while the app runs)');
      // a live PID with no port the OS can name — the case that used to refuse — is probed: a recycled PID is no owner
      const silent = discoverDesktop(ws, { pidAlive: () => true, listeningPortOf: () => 0, claimVerdict: verdict('reused'), bootedAt: () => 1 });
      A.eq(probes, [4242], 'a live owner with no port is probed, once');
      A.eq([silent.ownerAlive, silent.ownerReused], [false, true], 'and a recycled PID is not the owner');
      // a claim stamped before this computer last started is dead before any PID check (the station's own boot rule)
      fs.writeFileSync(path.join(ws, '.starnet-workspace-owner.json'), JSON.stringify({ version: 1, pid: 4242, nonce: 'n', startedAt: 1000 }));
      let asked = 0;
      const stale = discoverDesktop(ws, { pidAlive: () => { asked++; return true; }, listeningPortOf: () => 51234, claimVerdict: verdict('same-process'), bootedAt: () => 10000000 });
      A.eq([stale.ownerAlive, stale.ownerStale, asked], [false, true, 0], 'a pre-boot claim names no running station, and its PID is not even asked about');
      const unknownBoot = discoverDesktop(ws, { pidAlive: () => true, listeningPortOf: () => 51234, claimVerdict: verdict('same-process'), bootedAt: () => 0 });
      A.eq(unknownBoot.ownerAlive, true, 'an unknown boot time proves nothing');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  if (await portAnswers(8787)) { console.log('cli-owner-identity.test: something answers on 127.0.0.1:8787 (a running `npm start` would be attached first) — skipped the CLI cases'); A.report('cli-owner-identity.test'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-owner-identity-'));
  try {
    const env = Object.assign({}, process.env, {
      APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile, STARNET_APP_EXE: '',
      STARNET_PORT: '', SKYNET_PORT: '', STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '', STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: ''
    });
    if (process.platform !== 'win32') env.HOME = profile;
    const appData = process.platform === 'darwin' ? path.join(profile, 'Library', 'Application Support', 'ai.skynet.harness')
      : path.join(profile, 'ai.skynet.harness');
    const ws = path.join(appData, 'workspaces');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify({ version: 1, agents: [{ agentId: 'agent', name: 'ULTRON' }] }));
    fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({ agents: [{ agentId: 'agent', name: 'ULTRON' }] }));
    // an app that ran here, from a place that is gone now: no app to start (so the closed path ends in exit 3, not a launch)
    fs.writeFileSync(path.join(appData, 'startup.log'), 'startup exe=Ok("' + path.join(profile, 'gone', 'skynet-desktop.exe').replace(/\\/g, '\\\\') + '") port=1\nspawn_sidecar pid=999999 port=1 listening=true\n');
    const lock = path.join(ws, '.starnet-workspace-owner.json');
    const born = Date.now() - Math.round(process.uptime() * 1000);   // when THIS process was created (±a little)
    let self = {};
    if (process.platform === 'linux') {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      self = { startTicks: require('../sidecar/process-identity.js')._internals.parseProcStat(stat) };
    }

    // 1. the claim names THIS live process, stamped an hour before it was created: a recycled PID
    const recycled = Object.assign({ version: 1, pid: process.pid, nonce: 'recycled', startedAt: born - 3600000, executable: process.execPath },
      self.startTicks ? { startTicks: self.startTicks + '1' } : {});
    fs.writeFileSync(lock, JSON.stringify(recycled));
    const r = await cli(['-p', 'say hello', '--timeout', '5'], env, 90000);
    A.ok(!/owns the default workspace/.test(r.err), 'a recycled PID is not read as the live station (stderr: ' + tail(r.err) + ')');
    A.eq(r.code, 3, 'it takes the app-closed path: exit 3 here, with no app on this computer to start');
    A.ok(/app was not found/.test(r.err), 'and says the app was not found, as for any closed station (' + tail(r.err) + ')');
    A.eq(JSON.parse(fs.readFileSync(lock, 'utf8')).nonce, 'recycled', 'the claim is left exactly where it was');

    // 2. the same PID, stamped after this process was created: the claimant itself, so a live owner
    const live = Object.assign({ version: 1, pid: process.pid, nonce: 'live', startedAt: Date.now(), executable: process.execPath },
      self.startTicks ? { startTicks: self.startTicks } : {});
    fs.writeFileSync(lock, JSON.stringify(live));
    const l = await cli(['-p', 'say hello', '--timeout', '5'], env, 90000);
    A.eq(l.code, 3, 'a live owner whose port is unknown: refused, exit 3 (stderr: ' + tail(l.err) + ')');
    A.ok(new RegExp('owns the default workspace \\(pid ' + process.pid + '\\)').test(l.err), 'it names the live owner\'s PID, as before');
    A.ok(!/booting a station/.test(l.err), 'no second station on a live owner\'s workspace');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  A.report('cli-owner-identity.test');
})().catch(e => { console.error(e); process.exit(1); });
