/* node test/channels.telegram.connect-pairing.e2e.test.js -- live proof of first-time Telegram setup.

   Boots the real sidecar against a fake Bot API, connects through the authenticated HTTP route, proves an
   ordinary pre-pair DM is refused, completes the returned /pair command over the real long-poll adapter, and
   proves the resulting operational state survives a sidecar restart. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

async function startTelegram() {
  const calls = [];
  const sends = [];
  const queued = [];
  const waiters = [];
  let updateId = 100;
  let messageId = 500;

  function respond(res, value) {
    if (res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  function flush() {
    while (queued.length && waiters.length) respond(waiters.shift(), { ok: true, result: [queued.shift()] });
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const method = String(req.url || '').split('/').pop();
    const body = await readJson(req);
    calls.push({ method, body });
    if (method === 'getMe') {
      respond(res, { ok: true, result: { id: 42, username: 'pairing_test_bot', first_name: 'Pairing Test' } });
      return;
    }
    if (method === 'deleteWebhook' || method === 'setMyCommands') {
      respond(res, { ok: true, result: true });
      return;
    }
    if (method === 'getUpdates') {
      if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
      if (queued.length) { respond(res, { ok: true, result: [queued.shift()] }); return; }
      waiters.push(res);
      req.on('close', () => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
      setTimeout(() => {
        const i = waiters.indexOf(res);
        if (i >= 0) respond(waiters.splice(i, 1)[0], { ok: true, result: [] });
      }, 50);
      return;
    }
    if (method === 'sendMessage') {
      sends.push(body);
      respond(res, { ok: true, result: { message_id: ++messageId } });
      return;
    }
    respond(res, { ok: true, result: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return {
    base: 'http://' + HOST + ':' + server.address().port,
    calls,
    sends,
    push(chatId, userId, text) {
      queued.push({ update_id: ++updateId, message: {
        message_id: ++messageId, date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text
      } });
      flush();
    },
    close() {
      while (waiters.length) respond(waiters.shift(), { ok: true, result: [] });
      return new Promise(resolve => server.close(resolve));
    }
  };
}

async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const telegram = await startTelegram();
  const env = {
    SKYNET_TELEGRAM_API_BASE: telegram.base,
    STARNET_TELEGRAM_API_BASE: telegram.base
  };
  const sidecar = SidecarFixture.create({ prefix: 'starnet-tg-connect-pair-', env, timeoutMs: 20000 });
  try {
    await sidecar.start();
    const connectBody = {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-pairing-test', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'test agent'
    };
    // review2 #1: a connect that hands out an owner code is an authority change; the page key alone gets the desk's question
    const unconfirmed = await sidecar.json('POST', '/api/channels/telegram/connect', connectBody);
    A.eq(unconfirmed.status, 403, 'a first connect with no owner asks at the desk first');
    A.eq(unconfirmed.body && unconfirmed.body.code, 'desk_confirm_required', 'with the desk challenge');
    A.ok(!unconfirmed.body.pairingCode, 'and hands out no owner code');
    A.eq((await sidecar.json('GET', '/api/channels/telegram/status')).body.configured, false, 'nothing was saved or started before the desk said yes');
    const connected = await sidecar.deskJson('POST', '/api/channels/telegram/connect', connectBody);
    A.eq(connected.status, 200, 'authenticated Telegram connect succeeds once the desk confirms it');
    A.eq(connected.body.pairingRequired, true, 'connect says owner pairing is still required');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(connected.body.pairingCode || '')), 'connect returns the one-time local pairing code');

    // Resolve the first real long-poll with the exact failing user action: a normal DM before owner pairing.
    telegram.push(7001, 99, 'hello before pairing');
    try {
      await waitUntil(async () => {
        const r = await sidecar.json('GET', '/api/channels/telegram/status');
        return r.body && r.body.connected;
      }, 5000, 'first successful Bot API poll');
    } catch (error) {
      error.message += '\nBot API calls: ' + JSON.stringify(telegram.calls) + '\nSidecar output:\n' + sidecar.output();
      throw error;
    }
    let status = (await sidecar.json('GET', '/api/channels/telegram/status')).body;
    A.eq(status.connected, true, 'transport polling is proven up');
    A.eq(status.ownerLocked, false, 'no Telegram owner is trusted yet');
    A.eq(status.acceptingDms, false, 'an unpaired poller honestly reports that it is not accepting DMs');
    A.eq(status.ownerPairingActive, true, 'the returned pairing challenge is active');

    await sleep(150);
    A.eq(telegram.sends.length, 0, 'ordinary DMs are refused before owner pairing');

    telegram.push(7001, 99, '/pair ' + connected.body.pairingCode);
    await waitUntil(() => telegram.sends.some(send => /Owner paired/i.test(String(send.text || ''))), 5000, 'owner-pair acknowledgement');
    status = (await sidecar.json('GET', '/api/channels/telegram/status')).body;
    A.eq(status.ownerLocked, true, 'the Telegram user is now the persisted owner');
    A.eq(status.acceptingDms, true, 'the same live poller now truthfully reports that it accepts DMs');

    await sidecar.restart(env);
    await waitUntil(async () => {
      const r = await sidecar.json('GET', '/api/channels/telegram/status');
      return r.body && r.body.connected;
    }, 5000, 'Telegram poller after restart');
    status = (await sidecar.json('GET', '/api/channels/telegram/status')).body;
    A.eq(status.ownerLocked, true, 'owner enrollment survives a real sidecar restart');
    A.eq(status.acceptingDms, true, 'operational Telegram DM state survives restart');

    // review2 #1: a reconnect that keeps the owner asks nothing; revoking (taking power away) asks nothing; but the way
    // back to a new owner, by connect or by PAIR OWNER, goes through the desk again
    const kept = await sidecar.json('POST', '/api/channels/telegram/connect', {});
    A.eq(kept.status, 200, 'a reconnect that keeps the paired owner needs no desk confirmation');
    A.eq(kept.body.pairingRequired, false, 'and makes no owner code');
    const revoked = await sidecar.json('POST', '/api/channels/telegram/owner/revoke', {});
    A.eq(revoked.status, 200, 'revoking the owner needs no desk confirmation');
    const rechain = await sidecar.json('POST', '/api/channels/telegram/connect', {});
    A.eq(rechain.status, 403, 'a reconnect after the revoke cannot mint a new owner code with the page key alone');
    A.ok(!rechain.body.pairingCode, 'no code in the refusal');
    const repair = await sidecar.json('POST', '/api/channels/telegram/owner/pair', {});
    A.eq(repair.status, 403, 'nor can PAIR OWNER');
    A.ok(repair.body.code === 'desk_confirm_required' && !repair.body.expiresAt, 'it is the desk question, not a code');
    A.eq((await sidecar.json('GET', '/api/channels/telegram/status')).body.ownerPairingActive, false, 'no owner challenge became active');
  } finally {
    await sidecar.dispose();
    await telegram.close();
  }
  A.report('channels.telegram.connect-pairing.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
