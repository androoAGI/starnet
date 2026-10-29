/* node test/channels.relay-owner.e2e.test.js — LIVE proof that the signed relay ingress can no longer vouch for
   a sender the channel never admitted (2026-09-25, sec-owner-gates).

   The relay HMAC proves the operator's relay sent a body; it never proved WHO on the platform wrote it (one
   station-wide secret, no per-user scope). /api/channels/webhook/<channel> used to spread the body straight
   into hub.onInbound: a relay-claimed stranger skipped the owner-only DM gate, a relay-claimed owner id minted
   owner authority, and body fields like `directReply` were obeyed. Boots the REAL sidecar with a fake Telegram
   Bot API + fake provider, pairs the owner through the real local pairing route, then drives signed webhooks:
     - a DM claiming a non-owner sender is refused 403 and nothing is sent to that chat
     - a group the bot never allowlisted is refused 403
     - the paired owner's relayed /status is answered through the real hub, and a smuggled directReply is ignored */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const SECRET = 'r'.repeat(48);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockOpenRouter() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Relay answer' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function startMockTelegram() {
  const calls = [], sends = [], queued = [], waiters = [];
  let updateId = 1000, messageId = 2000;
  const respond = (res, obj) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) respond(waiters.shift().res, { ok: true, result: [queued.shift()] }); };
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });
      if (method === 'getUpdates') {
        if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
        if (queued.length) { respond(res, { ok: true, result: [queued.shift()] }); return; }
        const waiter = { res };
        waiters.push(waiter);
        req.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getMe') { respond(res, { ok: true, result: { id: 1, is_bot: true, username: 'relaytestbot', first_name: 'Relay' } }); return; }
      respond(res, { ok: true, result: true });
    });
    server.listen(0, HOST, () => resolve({
      calls, sends, server, base: 'http://' + HOST + ':' + server.address().port,
      pushText(chatId, userId, text) {
        queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
        flush();
      },
      close() { while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] }); server.close(() => {}); }
    }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port; sidecar output:\n' + out));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(25); }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-relay-owner-'));
  const home = path.join(ws, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    // never let a test sidecar see (or recover into) the real user profile
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), HERMES_HOME: path.join(home, '.hermes'),
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-relay-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-relay-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base,
    STARNET_CHANNEL_WEBHOOK_SECRET: SECRET
  };
  let child = null;
  try {
    const live = await boot(await allocatePort(), env, 20);
    child = live.child;
    const B = 'http://' + HOST + ':' + live.port;
    const token = await bootToken(B, B);
    const relay = async (message) => {
      const body = JSON.stringify({ message });
      const ts = String(Date.now()), nonce = 'nonce_' + crypto.randomBytes(12).toString('hex');
      const r = await fetch(B + '/api/channels/webhook/telegram', { method: 'POST', body, headers: {
        'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B,
        'x-starnet-timestamp': ts, 'x-starnet-nonce': nonce,
        'x-starnet-signature': crypto.createHmac('sha256', SECRET).update(ts + '.' + nonce + '.' + body).digest('hex')
      } });
      let j = {}; try { j = await r.json(); } catch (_) {}
      return { status: r.status, j };
    };

    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset !== -1), 8000, 'telegram poll loop');
    // Before pairing, a relay can never claim the unowned bot.
    const early = await relay({ chatId: '7777', userId: '7777', text: 'hello, I am the owner now', chatType: 'dm' });
    A.eq(early.status, 403, 'an UNPAIRED bot admits no relay DM (a relay cannot claim ownership)');

    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' }, body: '{}' })).json();
    A.ok(pair && /^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'local owner pairing issued a one-time code');
    tg.pushText(4242, 99, '/pair ' + pair.code);
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '4242' && /Owner paired/i.test(String(s.text || ''))), 8000, 'owner-pair acknowledgement');

    const stranger = await relay({ chatId: '5151', userId: '5151', text: '/new', chatType: 'dm' });
    A.eq(stranger.status, 403, 'a relay DM claiming a non-owner sender is refused');
    A.ok(/not the paired owner/.test(String(stranger.j.error || '')), 'the refusal names the reason');
    const offList = await relay({ chatId: '-100500', userId: '99', text: '/status', chatType: 'group' });
    A.eq(offList.status, 403, 'a group the bot never allowlisted is refused even when the relay claims the owner');

    const sendsBefore = tg.sends.length;
    const owner = await relay({ chatId: '4242', userId: '99', text: '/status', chatType: 'dm', directReply: 'PWNED_BY_RELAY_BODY' });
    A.eq(owner.status, 202, 'the paired owner\'s relayed message is admitted');
    await waitUntil(() => tg.sends.slice(sendsBefore).some(s => String(s.chat_id) === '4242' && /Idle|Working/.test(String(s.text || ''))), 8000, 'relayed /status answer');
    A.ok(!tg.sends.some(s => /PWNED_BY_RELAY_BODY/.test(String(s.text || ''))), 'a body-supplied directReply is never obeyed');
    await sleep(300);
    A.ok(!tg.sends.some(s => ['5151', '-100500', '7777'].indexOf(String(s.chat_id)) >= 0), 'nothing was ever sent to a refused chat');
  } finally {
    try { child && child.kill(); } catch (_) {}
    try { tg.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.relay-owner.e2e.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
