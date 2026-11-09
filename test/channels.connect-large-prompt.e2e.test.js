/* node test/channels.connect-large-prompt.e2e.test.js -- a big agent prompt must never kill a channel CONNECT.

   User report (2026-10-15): Telegram AND Discord both showed "✕ Failed to fetch" on CONNECT/RESUME, through
   restarts and fresh tokens. The panel sends the agent's composed system prompt in the connect body; the routes
   capped it at 64 KB and http-body destroyed the request on overflow, so the browser got a reset socket and no
   answer at all. This boots the real sidecar against a fake Bot API and proves: a 300 KB prompt connects + syncs,
   and a body past the channel cap gets a READABLE 413 (an HTTP answer, never a dropped connection). */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';

async function startTelegram() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const method = String(req.url || '').split('/').pop();
      const result = method === 'getMe' ? { id: 42, username: 'big_prompt_bot', first_name: 'Big Prompt' }
        : method === 'getUpdates' ? [] : true;
      // getUpdates long-polls in the real API; answer slowly enough that the poll loop does not spin.
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      }, method === 'getUpdates' ? 200 : 0);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { base: 'http://' + HOST + ':' + server.address().port, close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

// A realistic long prompt: multibyte text + newlines (JSON escaping grows it), well past the old 64 KB cap.
function bigPrompt(bytes) {
  const para = 'Standing order — cite sources, keep it terse, never message anyone without asking. 日本語のメモ。\n';
  let s = 'You are ULTRON.\n';
  while (Buffer.byteLength(s) < bytes) s += para;
  return s;
}

(async () => {
  const telegram = await startTelegram();
  const env = { SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base };
  const sidecar = SidecarFixture.create({ prefix: 'starnet-channel-big-prompt-', env, timeoutMs: 20000 });
  try {
    await sidecar.start();
    const system = bigPrompt(300 * 1024);
    A.ok(Buffer.byteLength(JSON.stringify({ system })) > 4 * (1 << 16), 'the prompt is several times the old 64 KB cap');

    const connected = await sidecar.deskJson('POST', '/api/channels/telegram/connect', {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-big-prompt-test', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system
    });
    A.eq(connected.status, 200, 'a 300 KB agent prompt connects Telegram (was a dropped socket: "Failed to fetch")');
    A.ok(!connected.body.error, 'no error in the connect answer');

    const synced = await sidecar.json('POST', '/api/channels/telegram/sync', { agentId: 'agent', system, agentName: 'ULTRON' });
    A.eq(synced.status, 200, 'the identity sync accepts the same prompt (it used to fail silently)');
    A.eq(synced.body.synced, true, 'the sync is applied');

    // Past the channel cap: the route must still ANSWER — a clean 413 with words — never reset the connection.
    let tooBig = null, thrown = null;
    try {
      tooBig = await sidecar.json('POST', '/api/channels/discord/connect', { token: 'x', model: 'test/model', system: 'a'.repeat(5 << 20) });
    } catch (e) { thrown = e; }
    A.ok(!thrown, 'an oversized connect gets an HTTP answer, not a dropped connection' + (thrown ? ' (' + thrown.message + ')' : ''));
    A.eq(tooBig && tooBig.status, 413, 'an oversized connect answers 413');
    A.ok(/too large/.test(String(tooBig && tooBig.body && tooBig.body.error)), 'the 413 says in words that the setup text is too large');

    // Every OTHER route keeps its own cap, but an overflow there must also be an answer, never a reset.
    let keyAnswer = null, keyThrown = null;
    try { keyAnswer = await sidecar.json('POST', '/api/agent/delete', { pad: 'a'.repeat(2 << 20) }); } catch (e) { keyThrown = e; }
    A.ok(!keyThrown, 'a non-channel route over its cap still answers' + (keyThrown ? ' (' + keyThrown.message + ')' : ''));
    A.ok(keyAnswer && keyAnswer.status >= 400 && keyAnswer.status < 500, 'that answer is a 4xx refusal (got ' + (keyAnswer && keyAnswer.status) + ')');

    const health = await sidecar.json('GET', '/api/channels/telegram/status');
    A.eq(health.status, 200, 'the sidecar is still serving after the oversized uploads');
  } catch (error) {
    error.message += '\nSidecar output:\n' + sidecar.output();
    throw error;
  } finally {
    await sidecar.dispose();
    await telegram.close();
  }
  A.report('channels.connect-large-prompt.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
