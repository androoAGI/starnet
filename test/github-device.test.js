'use strict';
const assert = require('node:assert/strict');
const { createDeviceFlow, TOKEN_ENDPOINT } = require('../sidecar/mcp/github-device.js');
const oauth = require('../sidecar/mcp/oauth.js');
async function main() {
  let clock = 1000, config = 'old', count = 0, writes = 0, mode = 'pending', release;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    let value;
    if (url.endsWith('/device/code')) value = { device_code: 'PRIVATE_DEVICE', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
    else if (url.endsWith('/user')) value = { id: 42, login: 'tester' };
    else {
      count++;
      if (mode === 'held') await new Promise(r => { release = r; });
      value = mode === 'pending' ? { error: 'authorization_pending' } : mode === 'slow' ? { error: 'slow_down' } : mode === 'denied' ? { error: 'access_denied' } :
        { access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 28800, scope: 'repo,read:org', token_type: 'bearer' };
    }
    return { ok: true, status: 200, json: async () => value };
  };
  const flow = createDeviceFlow({ fetchImpl, now: () => clock, snapshot: () => config,
    complete: async (id, grant, active) => { assert(active()); assert.equal(grant.clientSecret, ''); assert.equal(grant.account.login, 'tester'); writes++; return { state: 'connected', login: grant.account.login }; } });
  const start = await flow.start('attempt1', 'github');
  assert.equal(start.userCode, 'ABCD-EFGH'); assert(!JSON.stringify(start).includes('PRIVATE'));
  assert.equal((await flow.poll('attempt1')).state, 'pending'); assert.equal(count, 0);
  clock += 5000; assert.equal((await flow.poll('attempt1')).state, 'pending'); assert.equal(count, 1);
  mode = 'slow'; clock += 5000; await flow.poll('attempt1'); clock += 5000; await flow.poll('attempt1'); assert.equal(count, 2);
  clock += 5000; mode = 'held'; const first = flow.poll('attempt1'); const second = flow.poll('attempt1');
  await new Promise(r => setImmediate(r)); assert.equal(count, 3); release();
  assert.equal((await first).state, 'connected'); assert.equal((await second).state, 'connected'); assert.equal(writes, 1);
  assert(!JSON.stringify(await flow.poll('attempt1')).includes('PRIVATE')); assert.equal(writes, 1);
  await flow.start('attempt2', 'github'); clock += 5000; config = 'changed'; assert.equal((await flow.poll('attempt2')).state, 'error'); assert.equal(writes, 1);
  await flow.start('attempt3', 'github'); clock += 5000; mode = 'held'; const pending = flow.poll('attempt3');
  await new Promise(r => setImmediate(r)); flow.cancel('attempt3', 'github'); release(); assert.equal((await pending).state, 'error'); assert.equal(writes, 1);
  await flow.start('attempt4', 'github'); clock += 900001; assert.equal((await flow.poll('attempt4')).state, 'error');
  await flow.start('attempt5', 'github'); clock += 5000; mode = 'denied'; assert.match((await flow.poll('attempt5')).error, /declined/);
  await flow.start('attempt6', 'github'); await flow.start('attempt7', 'github'); assert.equal((await flow.poll('attempt6')).state, 'error');
  assert(calls.filter(c => c.url === TOKEN_ENDPOINT).every(c => !c.opts.body.includes('client_secret')));
  await assert.rejects(oauth.refreshTokens({ fetchImpl: async () => ({ status: 200, json: async () => ({ error: 'invalid_grant' }) }), tokenEndpoint: TOKEN_ENDPOINT, now: clock }), /invalid_grant/);
  console.log('github-device: polling, slowdown, single-flight, cancellation, stale-config, expiry, denial, refresh error and secret redaction passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
