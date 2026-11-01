/* node test/routine-delivery.parts.e2e.test.js — the real sidecar never sends a routine's part twice, across a refused part
   and a restart (channel-delivery-ledger S4).

   A routine's long result is delivered in parts. Before this lane a part the platform refused failed the whole delivery,
   and the cron's retry — in the next process too — sent the digest again from its first part, so the chat got parts 1
   and 2 twice; and a reply the station made in the same chat meanwhile went out on its own path, between the parts.

   This boots the real sidecar (SKYNET_CRON_TICK_MS=5000) against a fake Bot API and a fake model. The owner pairs, a
   routine delivering to the owner's chat runs (Run Now, the scheduled fire's delivery path) and writes a three-part digest;
   the Bot API refuses part 3 — every attempt, until the station restarts. While part 3 waits, the owner writes and the
   station answers. The sidecar is stopped and started again over the same workspace (Telegram reconnects from its saved
   config), and the Bot API takes part 3 now. Off the calls the Bot API received, it proves:
     1. parts 1 and 2 each reached the chat exactly once, and part 3 once (accepted), however often it was refused;
     2. the station's reply, made while the digest was half delivered, never landed between its parts;
     3. the routine ends recorded as delivered (lastDeliveryOk true) once the cron asks again.
   RED at trunk a3af8dafd (scratch checkout, this file copied in): after the restart the cron's retry sends parts 1 and 2
   again, and the reply landed between part 2 and the resent digest. On http.list, and on slow.list for its time. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const CHAT = 4242;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(100); }
  throw new Error('timed out waiting for ' + label);
}

/* THE DIGEST: three blocks, each a little under one Telegram message, each opened by a marker line long enough that the
   one chunker cuts between the blocks (a cut lands at the last line break before 4096 characters). */
const block = (k) => ['PART' + k + '_MARK ' + 'm'.repeat(300)].concat(Array.from({ length: 38 }, (_, i) => 'P' + k + ' line ' + String(i).padStart(2, '0') + ' ' + 'x'.repeat(80))).join('\n');
const DIGEST = [block(1), block(2), block(3)].join('\n');
const partOf = (text) => { const m = /PART(\d)_MARK/g; const got = []; let x; while ((x = m.exec(String(text)))) got.push(Number(x[1])); return got; };

// a fake Bot API: long polls answered from a queue, every other call recorded; part 3 is refused while `refusePart3`
async function startTelegram() {
  const calls = [];
  const queued = [], waiters = [];
  let nextId = 100, updateId = 0;
  const api = { calls: calls, refusePart3: true };
  const reply = (res, status, obj) => { try { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); reply(w.res, 200, { ok: true, result: [queued.shift()] }); } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const method = String(req.url || '').split('?')[0].split('/').pop();
      let fields = {};
      try { fields = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) {}
      if (method === 'getUpdates') {
        if (fields.offset === -1) return reply(res, 200, { ok: true, result: [] });
        if (queued.length) return reply(res, 200, { ok: true, result: [queued.shift()] });
        const w = { res: res, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reply(res, 200, { ok: true, result: [] }); }, 800) };
        waiters.push(w);
        return;
      }
      if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 42, is_bot: true, username: 'parts_bot', first_name: 'Parts' } });
      const call = { method: method, fields: fields, at: Date.now() };
      calls.push(call);
      if (method === 'sendMessage' && api.refusePart3 && partOf(fields.text).indexOf(3) >= 0) {
        call.refused = true;
        return reply(res, 502, { ok: false, error_code: 502, description: 'Bad Gateway' });
      }
      const result = /^send/.test(method) ? { message_id: nextId++, chat: { id: Number(fields.chat_id) || 0 } } : true;
      return reply(res, 200, { ok: true, result: result });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  api.base = 'http://' + HOST + ':' + server.address().port;
  api.pushText = (chatId, userId, text) => {
    queued.push({ update_id: ++updateId, message: { message_id: 5000 + updateId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Ana', username: 'ana' }, text: text } });
    flush();
  };
  api.close = () => new Promise(r => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); reply(w.res, 200, { ok: true, result: [] }); } server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return api;
}

function sse(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
// the model: the routine's prompt gets the three-part digest; the owner's chat message gets a one-line answer
async function startModel() {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const blob = JSON.stringify(body.messages || []);
      if (blob.includes('ROUTINE_PARTS')) return sse(res, DIGEST);
      if (blob.includes('how is the station')) return sse(res, 'All quiet on the station. HUB_REPLY_MARK');
      return sse(res, 'Noted.');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

(async () => {
  const t0 = Date.now();
  const telegram = await startTelegram();
  const model = await startModel();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-routine-parts-',
    env: {
      SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base,
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-routine-parts-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-routine-parts-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0', SKYNET_CRON_TICK_MS: '5000', STARNET_CRON_TICK_MS: '5000',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  const sends = () => telegram.calls.filter(c => c.method === 'sendMessage' && String(c.fields.chat_id) === String(CHAT));
  const landed = (k) => sends().filter(c => !c.refused && partOf(c.fields.text).indexOf(k) >= 0).length;
  try {
    await sidecar.start();
    const connected = await sidecar.json('POST', '/api/channels/telegram/connect', {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-routine-parts-fake', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'You are ULTRON.'
    });
    A.eq(connected.status, 200, 'Telegram connects to the fake Bot API');
    const up = async () => { const s = await sidecar.json('GET', '/api/channels/telegram/status'); return !!(s.body && s.body.connected && s.body.state === 'up'); };
    await waitFor(up, 20000, 'Telegram to report up');
    // the owner pairs, the way a desktop owner does (a one-time code, consumed by Telegram)
    const pair = await sidecar.json('POST', '/api/channels/telegram/owner/pair', {});
    A.ok(pair.body && pair.body.code, 'a one-time owner pairing code');
    telegram.pushText(CHAT, CHAT, '/pair ' + pair.body.code);
    await waitFor(() => sends().some(c => /Owner paired/i.test(String(c.fields.text || ''))), 15000, 'the owner pairing acknowledgement');

    const created = await sidecar.json('POST', '/api/cron', {
      name: 'Parts digest', prompt: 'ROUTINE_PARTS write the overnight digest', schedule: 'every 24h', agentId: 'agent', model: 'test/model', provider: 'openrouter',
      deliver: 'origin', origin: { channel: 'telegram', chatId: String(CHAT) },
      arm: true   // what the create form sends: the scheduler's tick is armed, and stays armed across the restart
    });
    A.ok(created.body && created.body.job && created.body.job.id, 'the routine is created' + (created.body && created.body.error ? ' (' + created.body.error + ')' : ''));
    const jobId = created.body.job.id;
    const mark = telegram.calls.length;
    const run = await sidecar.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
    A.eq(run.status, 200, 'Run Now streams');
    await run.text();
    // parts 1 and 2 land; part 3 is refused (the adapter's own resend too)
    await waitFor(() => landed(1) >= 1 && landed(2) >= 1 && sends().filter(c => c.refused).length >= 2, 30000, 'parts 1 and 2 to land and part 3 to be refused');
    A.eq([landed(1), landed(2), landed(3)], [1, 1, 0], 'the digest is half delivered: parts 1 and 2 landed, part 3 was refused');
    // while part 3 waits, the owner writes and the station answers
    telegram.pushText(CHAT, CHAT, 'how is the station doing?');
    await sleep(6000);

    // the station restarts (Telegram reconnects from its saved config); the platform takes part 3 now
    await sidecar.stop();
    telegram.refusePart3 = false;
    await sidecar.start();
    await waitFor(up, 30000, 'Telegram to reconnect after the restart');
    await waitFor(() => landed(3) >= 1, 60000, 'part 3 to land after the restart');
    await waitFor(() => sends().some(c => !c.refused && /HUB_REPLY_MARK/.test(String(c.fields.text || ''))), 30000, 'the station\'s reply to land');
    // the cron asks again once its retry is due (60 s after the refused first attempt), on a 5 s tick
    const state = await waitFor(async () => {
      const r = await sidecar.json('GET', '/api/cron');
      const j = (r.body && r.body.jobs || []).find(x => x.id === jobId);
      return j && j.lastDeliveryOk === true ? j : null;
    }, 120000, 'the routine to record its delivery as landed');
    await sleep(6000);   // a resend would arrive now

    A.eq([landed(1), landed(2), landed(3)], [1, 1, 1], 'each part reached the chat exactly once (was: parts 1 and 2 twice, sent again by the retry after the restart)');
    A.ok(sends().filter(c => c.refused).length >= 2, 'part 3 was refused before the restart (' + sends().filter(c => c.refused).length + ' refusals)');
    const seq = telegram.calls.slice(mark).filter(c => c.method === 'sendMessage' && !c.refused && String(c.fields.chat_id) === String(CHAT))
      .map(c => (/HUB_REPLY_MARK/.test(String(c.fields.text || '')) ? 'R' : partOf(c.fields.text).join('')))
      .filter(Boolean).join(',');
    A.eq(seq, '1,2,3,R', 'the station\'s reply, made while the digest was half delivered, waited for its last part (never between its parts)');
    A.eq([state.lastDeliveryOk, state.lastDeliveryError || null], [true, null], 'the routine records its delivery as landed');
    console.log('  routine-delivery.parts.e2e: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  } catch (error) {
    error.message += '\nBot API calls:\n' + telegram.calls.map(c => '  ' + c.method + (c.refused ? ' REFUSED' : '') + ' ' + JSON.stringify(c.fields).slice(0, 140)).join('\n');
    error.message += '\nSidecar output (tail):\n' + sidecar.output().slice(-6000);
    throw error;
  } finally {
    await sidecar.dispose();
    await telegram.close();
    await model.close();
  }
  A.report('routine-delivery.parts.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
