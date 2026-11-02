/* node test/recovery-temp-sweep.http.test.js — #119: only the desktop app sweeps Downloads at boot.

   A sidecar nobody opted in, under a profile that looks real, leaves a planted unfinished bundle alone. Neither dev mode
   being off nor the desktop-shell marker opens the door, because many tests boot with that marker and Windows gives them
   the real USERPROFILE. The "real" profile here is a temporary folder. The opt-in itself is proved by
   update-preparation.http.test.js, in its own sandbox. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function waitFor(fn, ms, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start >= ms) return reject(new Error(label()));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function bootOnce(sandbox, label, extra) {
  const dir = path.join(sandbox, label);
  const profile = path.join(dir, 'profile');
  const downloads = path.join(profile, 'Downloads');
  const workspace = path.join(dir, 'workspaces');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const planted = path.join(downloads, 'starnet-recovery-20261101-120000.starnet-recovery.json.tmp-999999-abcdef0123456789');
  fs.writeFileSync(planted, 'plaintext');
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile, USERPROFILE: profile, HOME: profile,
    SKYNET_WORKSPACES: workspace, SKYNET_PORT: String(port), SKYNET_API_TOKEN: 'recovery-temp-sweep-token-32-bytes-long',
    SKYNET_LIVE_PRICES: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_CRON: '0', SKYNET_EDGE_TTS_PROBE: '0',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
  }, extra);
  for (const k of ['SKYNET_DEV', 'STARNET_DEV', 'SKYNET_SWEEP_BACKUP_TEMPS', 'STARNET_SWEEP_BACKUP_TEMPS']) delete env[k];
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  try {
    // the sweep runs before the listen line: update-preparation.http.test.js relies on the same order, with the opt-in
    await waitFor(() => output.includes('http://127.0.0.1:' + port), 15000, () => label + ': sidecar boot timeout:\n' + output);
    A.eq(fs.existsSync(planted), true, label + ': a sidecar nobody opted in leaves the planted file alone');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    await new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
  }
}

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-temp-sweep-'));
  try {
    await bootOnce(sandbox, 'plain', {});
    await bootOnce(sandbox, 'desktop-marker', { STARNET_DESKTOP_SHELL: '1', STARNET_CONNECTOR_ENCRYPTION_KEY: 'ab'.repeat(32) });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  A.report('recovery-temp-sweep.http.test');
})().catch(e => { console.error(e); process.exit(1); });
