/* node test/cron-lock-recycled-pid.http.test.js — a crashed sidecar's cron.lock whose PID Windows has handed to an
   unrelated process must not mute the scheduler (sweep/autonomy 2026-10-20).

   THE HOLE (found live): the desktop shell's Windows force-kill can land while the tick holds WORKSPACES/cron.lock
   (every advance/settlement persist runs under it). The next boot's lock probe asks kill(pid,0); when the dead
   holder's PID now belongs to some other live process the answer is "alive", so the boot reconcile logged
   "cron.lock held by another live process", every tick no-op'd and no routine fired until the 8-minute age break —
   although the workspace-owner claim had already proven no other sidecar exists. The workspace lock carries the
   process-identity + boot-time proofs for exactly this; the cron lock was built without them. Now it is wired
   with both: a PID whose current process was born after the stamp is a recycled PID, and the lock is reclaimed.
   Real isolated sidecar; the "recycled PID" is a fresh child process stamped into a back-dated lockfile. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootToken } = require('./_httpToken.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bootSidecar(port, workspaces, attempts) {
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^(STARNET_|SKYNET_|HERMES_|OPENROUTER_)/i.test(k)) delete env[k];
    Object.assign(env, {
      SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0',
      SKYNET_CRON_ENABLED: '1', SKYNET_CRON_TICK_MS: '500',
      SKYNET_CLOUD_URL: '', SKYNET_CREDITS_URL: '', SKYNET_EDGE_TTS: '0', SKYNET_LIVE_PRICES: '0',
      LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
    });
    if (!path.resolve(workspaces).startsWith(path.resolve(os.tmpdir())) || port === 8787) throw new Error('refusing a non-isolated sidecar');
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.includes('http://' + HOST + ':' + port)) { settled = true; resolve({ child, port, out: () => out }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(allocatePort().then(next => bootSidecar(next, workspaces, attempts - 1)));
        else reject(new Error('no free sidecar port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 15000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cronlock-reuse-'));
  const now = Date.now();
  const job = cronStore.makeJob({ name: 'hourly', prompt: 'Summarize.', schedule: cron.parseSchedule('every 1h', now), agentId: 'agent' }, { id: 'hourly', now: now - 3600000 + 1000 });
  fs.writeFileSync(path.join(ws, 'cron.jobs.json'), JSON.stringify({ version: 1, jobs: [job] }));
  // the crashed holder wrote this 3 minutes ago (inside the 8-minute age break); its PID now names a process born since
  const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const lock = path.join(ws, 'cron.lock');
  fs.writeFileSync(lock, squatter.pid + ':0123456789abcdef');
  const t = (Date.now() - 180000) / 1000; fs.utimesSync(lock, t, t);
  let booted = null;
  try {
    booted = await bootSidecar(await allocatePort(), ws, 30);
    const B = 'http://' + HOST + ':' + booted.port;
    const token = await bootToken(B, B);
    let health = null;
    for (let i = 0; i < 40; i++) {
      health = (await (await fetch(B + '/api/cron', { headers: { 'X-StarNet-Token': token } })).json()).health;
      if (health && health.lastSuccessAt != null) break;
      await sleep(250);
    }
    A.ok(health && health.lastSuccessAt != null, 'the scheduler ticks: a recycled-PID lockfile is reclaimed, not obeyed for 8 minutes — health ' + JSON.stringify(health));
    A.eq(/held by another live process/.test(booted.out()), false, 'the boot reconcile never claims another live process holds the lock');
    A.ok(/cron\.tick|cron\.result/.test(booted.out()), 'and the due routine was processed by a real tick');
    A.ok(!fs.existsSync(lock) || !fs.readFileSync(lock, 'utf8').startsWith(squatter.pid + ':'), 'the dead holder\'s stamp is gone');
  } finally {
    try { if (booted) booted.child.kill(); } catch (_) {}
    try { squatter.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cron-lock-recycled-pid.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
