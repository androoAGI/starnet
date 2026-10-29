/* node test/channels.keychain-all.e2e.test.js — true-sidecar proof that Slack + Matrix credentials follow the
   Telegram/Discord keychain law on the desktop build (STARNET_DESKTOP_SHELL=1).

   The shell (src-tauri/src/credentials.rs) migrates plaintext channel tokens into the OS keychain BEFORE the
   sidecar spawns and injects them as SKYNET_<ID>_TOKEN. This test boots the REAL sidecar in the three states that
   migration can leave behind and proves each one keeps the channel configured without ever destroying the last
   copy of a secret:

     1. keychain write FAILED  -> the file still holds the tokens, no env. The channel stays configured, every
        save keeps the plaintext copy, and a later keychain push (POST /api/channels/token) earns the strip.
     2. migration SUCCEEDED    -> file is token-free, tokens arrive via env. Configured + durable, no token is ever
        written back to disk.
     3. keychain written, strip-write FAILED -> file AND env hold the same token. The sidecar's own boot migration
        proves durability from the env and strips the leftover plaintext copy.

   Every boot is isolated (temp WORKSPACES + APPDATA/LOCALAPPDATA/USERPROFILE/HOME) and no channel is enabled, so
   nothing reaches Slack or a homeserver. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const IPC = 'ipc-test-token-keychain-all';
const SLACK = 'xoxb-111-222-abc xapp-1-A1-333-def';
const MATRIX = 'syt_bWF0cml4_testtoken_0001';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, log: () => out }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 15000);
  });
}

function baseRecords(withTokens) {
  const slack = { model: 'test/model', provider: 'openrouter', enabled: false, name: 'NOVA', ownerId: '7' };
  const matrix = { model: 'test/model', provider: 'openrouter', enabled: false, name: 'NOVA', endpoint: 'http://127.0.0.1:9', ownerId: '8' };
  if (withTokens) { slack.token = SLACK; matrix.token = MATRIX; }
  return { slack, matrix, signal: { endpoint: 'http://127.0.0.1:9', account: '+15550001111', enabled: false, model: 'test/model' } };
}

async function withSidecar(label, secrets, extraEnv, fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-keychain-all-' + label + '-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-keychain-all-home-'));
  fs.mkdirSync(path.join(ws, 'channels'), { recursive: true });
  const file = path.join(ws, 'channels', 'secrets.json');
  fs.writeFileSync(file, JSON.stringify(secrets));
  const env = Object.assign({
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    STARNET_DESKTOP_SHELL: '1', SKYNET_DESKTOP_SHELL: '1',
    SKYNET_IPC_TOKEN: IPC, STARNET_IPC_TOKEN: IPC,
    SKYNET_SLACK_TOKEN: '', STARNET_SLACK_TOKEN: '', SKYNET_MATRIX_TOKEN: '', STARNET_MATRIX_TOKEN: '',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '',
    APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), USERPROFILE: home, HOME: home
  }, extraEnv);
  let child = null;
  try {
    const booted = await boot(await allocatePort(), env, 20);
    child = booted.child;
    const B = 'http://' + HOST + ':' + booted.port;
    const token = await bootToken(B, B);
    const api = (method, url, body, headers) => fetch(B + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
    const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    await fn({ api, disk, file, B });
  } finally {
    try { if (child) child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  // ---- 1. the shell's keychain write FAILED: plaintext is the last copy and must survive every save ----
  await withSidecar('fail', baseRecords(true), {}, async ({ api, disk }) => {
    const st = (await api('GET', '/api/channels/status')).j;
    A.ok(st.slack && st.slack.configured === true && st.slack.durable === true, 'write-failed: Slack stays configured from its plaintext copy');
    A.ok(st.matrix && st.matrix.configured === true && st.matrix.durable === true, 'write-failed: Matrix stays configured from its plaintext copy');
    A.ok(st.signal && st.signal.configured === true, 'Signal (config-only) stays configured');
    A.eq(disk().slack.token, SLACK, 'write-failed: boot did not strip the Slack pair');
    A.eq(disk().matrix.token, MATRIX, 'write-failed: boot did not strip the Matrix token');
    const serialized = JSON.stringify(st);
    A.ok(serialized.indexOf(SLACK) < 0 && serialized.indexOf(MATRIX) < 0, 'status never echoes a channel secret');

    // a save while the tokens are NOT durable must keep them on disk
    const sync = await api('POST', '/api/channels/slack/sync', { agentName: 'NOVA-2' });
    A.ok(sync.status === 200 && sync.j.synced === true && sync.j.persisted === true, 'write-failed: a config save is read-back proven');
    A.eq(disk().slack.token, SLACK, 'write-failed: a non-durable Slack pair survives a save (never destroy the last copy)');
    A.eq(disk().slack.name, 'NOVA-2', 'the save really rewrote the record');

    // the shell later manages to store it (keychain unlocked) and pushes it -> now durable -> the next save strips
    const noIpc = await api('POST', '/api/channels/token', { channel: 'slack', token: SLACK });
    A.eq(noIpc.status, 403, 'the keychain push refuses a caller without the per-launch IPC token');
    const push = await api('POST', '/api/channels/token', { channel: 'slack', token: SLACK }, { 'X-StarNet-Token': IPC });
    A.ok(push.status === 200 && push.j.configured === true, 'keychain push for Slack accepted');
    A.ok(JSON.stringify(push.j).indexOf(SLACK) < 0, 'the push response never echoes the token');
    const sync2 = await api('POST', '/api/channels/slack/sync', { agentName: 'NOVA-3' });
    A.ok(sync2.j.persisted === true, 'post-push save is read-back proven');
    const after = disk();
    A.ok(!('token' in after.slack), 'after a proven keychain push the Slack plaintext copy is stripped');
    A.eq(after.matrix.token, MATRIX, 'Matrix (still not keychained) keeps its plaintext copy');
    const st2 = (await api('GET', '/api/channels/status')).j;
    A.ok(st2.slack.configured === true && st2.slack.durable === true, 'Slack still configured + durable after its plaintext copy left');
  });

  // ---- 2. migration SUCCEEDED: token-free file + keychain env -> configured, and nothing is written back ----
  await withSidecar('ok', baseRecords(false), {
    SKYNET_SLACK_TOKEN: SLACK, STARNET_SLACK_TOKEN: SLACK, SKYNET_MATRIX_TOKEN: MATRIX, STARNET_MATRIX_TOKEN: MATRIX
  }, async ({ api, disk }) => {
    const st = (await api('GET', '/api/channels/status')).j;
    A.ok(st.slack.configured === true && st.slack.durable === true, 'migrated: Slack configured + durable from the keychain env');
    A.ok(st.matrix.configured === true && st.matrix.durable === true, 'migrated: Matrix configured + durable from the keychain env');
    await api('POST', '/api/channels/matrix/sync', { agentName: 'NOVA-4' });
    await api('POST', '/api/channels/slack/sync', { agentName: 'NOVA-4' });
    const raw = JSON.stringify(disk());
    A.ok(raw.indexOf(SLACK) < 0 && raw.indexOf(MATRIX) < 0, 'migrated: saves never write a keychain-held token back to disk');
    A.eq(disk().matrix.endpoint, 'http://127.0.0.1:9', 'migrated: the non-secret homeserver stays in the file');
  });

  // ---- 3. keychain written but the shell's strip-write failed: the sidecar finishes the strip at boot ----
  await withSidecar('strip', baseRecords(true), {
    SKYNET_SLACK_TOKEN: SLACK, STARNET_SLACK_TOKEN: SLACK, SKYNET_MATRIX_TOKEN: 'syt_DIFFERENT', STARNET_MATRIX_TOKEN: 'syt_DIFFERENT'
  }, async ({ api, disk }) => {
    const d = disk();
    A.ok(!('token' in d.slack), 'leftover: a plaintext copy matching the keychain env is stripped at boot');
    A.eq(d.matrix.token, MATRIX, 'leftover: a plaintext token that DIFFERS from the keychain value is never stripped');
    const st = (await api('GET', '/api/channels/status')).j;
    A.ok(st.slack.configured === true && st.matrix.configured === true, 'leftover: both channels stay configured');
  });

  A.report('channels.keychain-all.e2e.test');
})().catch(e => { console.log('FAIL: channels.keychain-all.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
