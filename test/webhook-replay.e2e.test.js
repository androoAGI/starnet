/* node test/webhook-replay.e2e.test.js — LIVE proof that webhook replay protection survives a sidecar restart.

   The nonce cache used to be in-memory only: reboot the sidecar inside the 300s skew window and the SAME
   signed request was admitted twice, while the ingress comment claimed exactly-once delivery. Boots the
   REAL sidecar over a temp workspaces dir, delivers a signed webhook (the nonce is durably recorded even
   though no live channel is connected — verification runs before the connection check), then RESTARTS the
   process over the same dir and replays the identical request: it must be refused as a replay, from disk. */
'use strict';

const A = require('./_assert.js');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const SECRET = 'w'.repeat(48);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

function signedHeaders(token, origin, timestamp, nonce, body) {
  return {
    'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: origin,
    'x-starnet-timestamp': timestamp, 'x-starnet-nonce': nonce,
    'x-starnet-signature': crypto.createHmac('sha256', SECRET).update(timestamp + '.' + nonce + '.' + body).digest('hex')
  };
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-webhook-replay-'));
  const env = { SKYNET_WORKSPACES: ws, STARNET_CHANNEL_WEBHOOK_SECRET: SECRET };
  const body = JSON.stringify({ message: { chatId: 'chat-1', text: 'hello station' } });
  const timestamp = String(Date.now());
  const nonce = 'nonce_e2e_' + crypto.randomBytes(12).toString('hex');
  let child, port;
  try {
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);

    // First delivery: signature + nonce are accepted (recorded durably); it then stops at the
    // "not connected" seam because no live channel exists in this harness — 409 with THAT error.
    const first = await fetch(B + '/api/channels/webhook/telegram', { method: 'POST', headers: signedHeaders(token, B, timestamp, nonce, body), body });
    A.eq(first.status, 409, 'first signed delivery reaches the channel seam');
    A.ok(/not connected/.test((await first.json()).error || ''), 'first delivery passed verification (refused only for the unconnected channel)');

    // The accepted nonce is on disk before the response went out (fail-closed ordering).
    const nonceFile = path.join(ws, 'webhook-nonces.jsonl');
    A.ok(fs.existsSync(nonceFile), 'webhook-nonces.jsonl was written to the workspaces dir');
    A.ok(fs.readFileSync(nonceFile, 'utf8').indexOf(nonce) >= 0, 'the durable inbox carries the delivered nonce');

    // Same-process replay is refused.
    const replaySame = await fetch(B + '/api/channels/webhook/telegram', { method: 'POST', headers: signedHeaders(token, B, timestamp, nonce, body), body });
    A.eq(replaySame.status, 409, 'same-process replay is 409');
    A.ok(/replay/.test((await replaySame.json()).error || ''), 'same-process replay names the replay refusal');

    // RESTART over the SAME workspaces dir, still inside the skew window — the historical hole.
    try { child.kill(); } catch (_) {}
    await sleep(300);
    ({ child, port } = await boot(await allocatePort(), env, 20));
    const B2 = 'http://' + HOST + ':' + port;
    const token2 = await bootToken(B2, B2);
    const replay = await fetch(B2 + '/api/channels/webhook/telegram', { method: 'POST', headers: signedHeaders(token2, B2, timestamp, nonce, body), body });
    A.eq(replay.status, 409, 'replayed request is refused after the restart');
    A.ok(/replay/.test((await replay.json()).error || ''), 'the restart replay is refused AS A REPLAY (nonce reloaded from disk)');

    // A FRESH nonce still verifies after the restart (the inbox refuses replays, not the world).
    const nonce2 = 'nonce_e2e_' + crypto.randomBytes(12).toString('hex');
    const ts2 = String(Date.now());
    const fresh = await fetch(B2 + '/api/channels/webhook/telegram', { method: 'POST', headers: signedHeaders(token2, B2, ts2, nonce2, body), body });
    A.eq(fresh.status, 409, 'fresh nonce reaches the channel seam after restart');
    A.ok(/not connected/.test((await fresh.json()).error || ''), 'fresh nonce verifies after restart (refused only for the unconnected channel)');
  } finally {
    try { child && child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('webhook-replay.e2e.test');
})().catch(e => { console.log('FAIL: webhook-replay.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
