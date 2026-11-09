/* node test/cron.upgrade-backlog.e2e.test.js -- the first boot of 0.14 after 0.13.x never floods a chat with old digests.

   0.13.x sent each routine reply as ONE Telegram message, so every digest over 4096 characters was refused ("message
   is too long") on every retry and stayed pending in cron.jobs.json. 0.14 splits long replies, which made that whole
   backlog deliverable at once; two routines delivering to one chat also interleaved their parts.

   This seeds a 0.13.5-shaped cron.jobs.json (two routines to one Telegram chat, 3 + 2 stuck over-long digests), boots
   the real sidecar against a fake Bot API and a fake model, then fires both routines at the same moment and proves,
   off the bytes the Bot API received:
     1. no stuck digest from the old version reaches the chat;
     2. each routine's fresh result arrives whole, its parts contiguous (never interleaved with the other routine);
     3. each delivery says how many earlier results are not coming (and promises no place it cannot back). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');

const HOST = '127.0.0.1';
const DAY = 86400000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startTelegram() {
  const calls = [];
  let nextId = 100;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const method = String(req.url || '').split('?')[0].split('/').pop();
      let fields = {};
      try { fields = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) {}
      const call = { method, fields };
      if (method !== 'getUpdates' && method !== 'getMe') calls.push(call);
      const rendered = String(fields.text || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      if (method === 'sendMessage' && Array.from(rendered).length > 4096) {
        call.refused = true;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }));
      }
      const result = method === 'getMe' ? { id: 42, is_bot: true, username: 'upgrade_backlog_bot', first_name: 'Upgrade' }
        : method === 'getUpdates' ? []
        : /^send/.test(method) ? { message_id: nextId++, chat: { id: Number(fields.chat_id) || 0 } }
        : true;
      // a real round trip takes time: a little latency per send is what lets two deliveries overlap
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      }, method === 'getUpdates' ? 200 : method === 'sendMessage' ? 40 : 0);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { calls, base: 'http://' + HOST + ':' + server.address().port, close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const longReply = tag => tag + '_START\n' + Array.from({ length: 200 }, (_, i) => tag + ' finding ' + i + ': the overnight digest line with details').join('\n') + '\n' + tag + '_END';

async function startModel() {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const blob = JSON.stringify(body.messages || []);
      if (blob.includes('ROUTINE_ALPHA')) return sse(res, [{ content: longReply('ALPHA') }]);
      if (blob.includes('ROUTINE_BRAVO')) return sse(res, [{ content: longReply('BRAVO') }]);
      return sse(res, [{ content: 'Station is quiet today.' }]);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = pred(); if (v) return v; await sleep(50); }
  throw new Error('timed out waiting for ' + label);
}

// cron.jobs.json exactly as 0.13.5 left it: each stuck digest a pending receipt refused as too long, retried for weeks.
function seedStore(file) {
  const now = Date.now();
  const origin = { target: null, channel: 'telegram', chatId: '777', threadId: null, sessionId: null, streamId: null, sessionTitle: null };
  const stale = (jobId, n, daysAgo) => ({
    id: jobId + '-old-' + n + ':final', runId: jobId + '-old-' + n, state: 'pending', outcome: 'ok',
    result: 'STALE_DIGEST ' + jobId + ' ' + n + '\n' + Array.from({ length: 150 }, (_, i) => 'old line ' + i + ' from weeks ago').join('\n'),
    error: null, usd: 0.02, deliver: 'origin', origin: origin,
    deliveryContext: { name: jobId, prompt: 'digest', agentId: 'agent', noAgent: false, attachToSession: false },
    destination: 'origin', committedAt: new Date(now - daysAgo * DAY).toISOString(), attempts: 30, deliveredAt: null,
    lastError: 'Bad Request: message is too long', deliveredTargets: [], nextAttemptAt: new Date(now - 60000).toISOString()
  });
  const job = (id, name, prompt, receipts) => Object.assign(cronStore.makeJob({
    id, name, prompt, agentId: 'agent', model: 'test/model', provider: 'openrouter', deliver: 'origin', origin,
    schedule: cron.parseSchedule('every 24h', now - 30 * DAY)
  }, { id, now: now - 30 * DAY }), {
    deliveryBacklog: receipts.slice(0, -1), finalization: receipts[receipts.length - 1],
    lastDeliveryOk: false, lastDeliveryError: 'Bad Request: message is too long', nextRunAt: new Date(now + DAY).toISOString()
  });
  const jobs = [
    job('alpha', 'Alpha digest', 'ROUTINE_ALPHA write the digest', [stale('alpha', 1, 21), stale('alpha', 2, 14), stale('alpha', 3, 1)]),
    job('bravo', 'Bravo digest', 'ROUTINE_BRAVO write the digest', [stale('bravo', 1, 9), stale('bravo', 2, 2)])
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs }, null, 2));
}

(async () => {
  const telegram = await startTelegram();
  const model = await startModel();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-cron-upgrade-backlog-',
    env: {
      SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base,
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-upgrade-backlog-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-upgrade-backlog-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  try {
    seedStore(path.join(sidecar.workspace, 'cron.jobs.json'));
    await sidecar.start();
    const connected = await sidecar.deskJson('POST', '/api/channels/telegram/connect', {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-upgrade-backlog-fake', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'You are ULTRON.'
    });
    A.eq(connected.status, 200, 'Telegram connects to the fake Bot API');
    const up = async () => { const s = await sidecar.json('GET', '/api/channels/telegram/status'); return s.body && s.body.connected && s.body.state === 'up'; };
    const until = Date.now() + 15000;
    while (!(await up())) { if (Date.now() > until) throw new Error('Telegram never reported up'); await sleep(100); }

    const listed = (await sidecar.json('GET', '/api/cron')).body.jobs || [];
    A.eq(listed.map(j => j.id).sort(), ['alpha', 'bravo'], 'the 0.13.5 routines load on 0.14');

    // both routines fire at the same moment (Run Now is the scheduled fire's delivery path)
    const runNow = id => sidecar.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.text());
    await Promise.all([runNow('alpha'), runNow('bravo')]);
    await waitFor(() => { const t = telegram.calls.map(c => String(c.fields.text || '')).join('\n'); return t.indexOf('ALPHA_END') >= 0 && t.indexOf('BRAVO_END') >= 0; }, 20000, 'both fresh digests to arrive');
    await sleep(1500);   // anything else queued would arrive now

    const sends = telegram.calls.filter(c => c.method === 'sendMessage');
    const texts = sends.map(c => String(c.fields.text || ''));
    A.ok(sends.every(c => String(c.fields.chat_id) === '777'), 'every message went to the routines\' chat');
    A.ok(sends.every(c => !c.refused), 'no part was refused as too long');
    A.ok(texts.every(t => t.indexOf('STALE_DIGEST') < 0 && t.indexOf('from weeks ago') < 0), 'not one stuck digest from the old version reaches the chat');

    const owner = t => (/ALPHA/.test(t) ? 'A' : '') + (/BRAVO/.test(t) ? 'B' : '');
    const seq = texts.map(owner).filter(Boolean).join('');
    A.ok(/^(A+B+|B+A+)$/.test(seq), 'each digest\'s parts arrive together, never interleaved (' + seq + ')');
    A.ok(seq.indexOf('AB') < 0 || seq.indexOf('BA') < 0, 'one switch between the two routines at most');
    const whole = tag => texts.filter(t => owner(t) === tag[0]).join('\n');
    A.ok(whole('ALPHA').indexOf('ALPHA finding 199:') >= 0 && whole('ALPHA').indexOf('ALPHA_END') > whole('ALPHA').indexOf('ALPHA_START'), 'the fresh Alpha digest arrives whole, in order');
    A.ok(whole('BRAVO').indexOf('BRAVO finding 199:') >= 0 && whole('BRAVO').indexOf('BRAVO_END') > whole('BRAVO').indexOf('BRAVO_START'), 'the fresh Bravo digest arrives whole, in order');
    A.ok(/3 earlier results of this routine were not delivered and will not be resent/.test(whole('ALPHA')), 'Alpha says its 3 earlier results are not coming');
    A.ok(/2 earlier results of this routine were not delivered and will not be resent/.test(whole('BRAVO')), 'Bravo says its 2 earlier results are not coming');
    // HISTORY lists only the latest runs and a script routine records none: the note promises no place it cannot back
    A.ok(texts.every(t => !/HISTORY|kept on the station/.test(t)), 'and promises no place to find them');
    A.eq(sends.length, texts.filter(t => owner(t)).length, 'nothing else was sent (' + sends.length + ' messages)');

    const after = (await sidecar.json('GET', '/api/cron')).body.jobs;
    for (const j of after) A.eq(j.lastDeliveryOk, true, j.id + ': the routine records its delivery as landed');
  } catch (error) {
    error.message += '\nBot API calls:\n' + telegram.calls.map(c => '  ' + c.method + ' ' + JSON.stringify(c.fields).slice(0, 160)).join('\n');
    error.message += '\nSidecar output (tail):\n' + sidecar.output().slice(-6000);
    throw error;
  } finally {
    await sidecar.dispose();
    await telegram.close();
    await model.close();
  }
  A.report('cron.upgrade-backlog.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
