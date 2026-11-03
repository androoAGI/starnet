/* node test/channels.ledger-upgrade.e2e.test.js — the real sidecar upgrades over what an older build left on a real disk
   (channel-delivery-ledger; the spec's risk: "inbox.json and outbox.json need a shape migration").

   test/channels.ledger-migration.test.js proves the migration record by record, on an in-memory disk. This is the same
   move as an install meets it: the real sidecar, its real store on the real file system (writeFileDurable, the hard-linked
   .bak an older build's writes leave), the real Telegram hub against a fake Bot API, and a fake model. The workspace holds
   an older build's channels/inbox.json and outbox.json, the .bak of each a hard link to its main. The sidecar boots,
   Telegram connects, and off the calls the Bot API received and the model's prompts it proves:
     1. the reply the old outbox owed lands once, with its delayed-reply line, and its finished answer the old inbox held
        lands once, and neither run again;
     2. a message that never reached a run replays once and is answered once;
     3. a message whose run had begun tool steps is never run again: the chat gets one notice;
     4. channels/delivery.json holds what is left (nothing owed), and the four v1 files are valid EMPTY envelopes, so an
        older build reading them neither replays nor resends;
     5. a restart over the migrated workspace sends nothing and runs nothing.
   RED on a scratch checkout of a3af8dafd: there is no delivery.json, and each .bak still holds what an older build would
   recover (32 s standalone). On http.list. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const CHAT = '4242';
const HEADER = '⌛ delayed reply — the channel was unreachable when this was first sent:';
const NOW = Date.now();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(100); }
  throw new Error('timed out waiting for ' + label);
}

// a fake Bot API: long polls that stay empty, every other call recorded
async function startTelegram() {
  const calls = [];
  const queued = [], waiters = [];
  let nextId = 100, updateId = 0;
  const api = { calls: calls };
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
      if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 42, is_bot: true, username: 'upgrade_bot', first_name: 'Upgrade' } });
      calls.push({ method: method, fields: fields });
      return reply(res, 200, { ok: true, result: /^send/.test(method) ? { message_id: nextId++, chat: { id: Number(fields.chat_id) || 0 } } : true });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  api.base = 'http://' + HOST + ':' + server.address().port;
  api.pushText = (chatId, userId, text) => {
    queued.push({ update_id: ++updateId, message: { message_id: 5000 + updateId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'private' }, from: { id: Number(userId), is_bot: false, first_name: 'Ana', username: 'ana' }, text: text } });
    flush();
  };
  api.close = () => new Promise(r => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); reply(w.res, 200, { ok: true, result: [] }); } server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return api;
}
// the model: each prompt recorded; it answers the replayed message by name
async function startModel() {
  const prompts = [];
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
      prompts.push(blob);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: blob.includes('NEVER_RAN_MARK') ? 'REPLAYED_ANSWER_MARK' : 'Noted.' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { prompts: prompts, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

/* WHAT AN OLDER BUILD LEFT: each main written, its .bak a hard link to it (writeJsonAtomic's way), and one later write of
   the main by rename, so the two are different files holding what an older build would recover. */
function seedOldBuild(root, chatId, owner) {
  const dir = path.join(root, 'channels');
  fs.mkdirSync(dir, { recursive: true });
  const dm = (mid, text) => ({ channel: 'telegram', chatId: chatId, chatType: 'dm', userId: owner, text: text, messageId: String(mid), ts: NOW - 60000 });
  const held = { text: 'HELD_ANSWER_MARK the finished answer', runId: 'old-run-held', reason: 'done', agentId: '', ids: ['telegram|' + chatId + '|3'] };
  const inbox = [
    { id: 'telegram|' + chatId + '|1', channel: 'telegram', message: dm(1, 'NEVER_RAN_MARK please look at this'), ts: NOW - 50000 },
    { id: 'telegram|' + chatId + '|2', channel: 'telegram', message: dm(2, 'STEPS_BEGUN_MARK rename the files'), ts: NOW - 40000, attempt: { runId: 'old-run-steps', tools: 2, boot: 'old-boot' } },
    { id: 'telegram|' + chatId + '|3', channel: 'telegram', message: dm(3, 'ANSWERED_MARK what was it'), ts: NOW - 30000, attempt: { runId: 'old-run-held', tools: 1, boot: 'old-boot' }, held: held }
  ];
  const outbox = [{ id: String(NOW - 70000) + '-1', channel: 'telegram', chatId: chatId, text: HEADER + '\nQUEUED_ANSWER_MARK the reply the old outbox owed', runId: 'old-run-queued', agentId: '', reason: 'done', ts: NOW - 70000, tries: 3 }];
  for (const [name, items] of [['inbox.json', inbox], ['outbox.json', outbox]]) {
    const main = path.join(dir, name);
    fs.writeFileSync(main, JSON.stringify({ version: 1, items: items }));
    fs.linkSync(main, main + '.bak');
  }
  return dir;
}

(async () => {
  const telegram = await startTelegram();
  const model = await startModel();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-ledger-upgrade-',
    env: {
      SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base,
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-ledger-upgrade-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-ledger-upgrade-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0', SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  const sends = () => telegram.calls.filter(c => c.method === 'sendMessage' && String(c.fields.chat_id) === CHAT);
  const landed = (mark) => sends().filter(c => String(c.fields.text || '').indexOf(mark) >= 0).length;
  // the chat's own runs (the station asks its model other things on a boot: the quest master's refresh)
  const runs = () => model.prompts.filter(p => p.indexOf('You are ULTRON') >= 0);
  const asked = (mark) => runs().filter(p => p.indexOf(mark) >= 0).length;
  const dir = seedOldBuild(sidecar.workspace, CHAT, CHAT);
  const file = (name) => path.join(dir, name);
  const owed = ['QUEUED_ANSWER_MARK', 'HELD_ANSWER_MARK', 'REPLAYED_ANSWER_MARK', 'NOT run again'];
  try {
    await sidecar.start();
    const connected = await sidecar.json('POST', '/api/channels/telegram/connect', {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-ledger-upgrade-fake', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'You are ULTRON.'
    });
    A.eq(connected.status, 200, 'Telegram connects to the fake Bot API');
    const up = async () => { const s = await sidecar.json('GET', '/api/channels/telegram/status'); return !!(s.body && s.body.connected && s.body.state === 'up'); };
    await waitFor(up, 20000, 'Telegram to report up');
    await waitFor(() => owed.every(m => landed(m) >= 1), 45000, 'everything the older build owed to land (' + owed.map(m => m + ':' + landed(m)).join(', ') + ')');
    await sleep(2500);   // a second copy would arrive now

    A.eq(landed('QUEUED_ANSWER_MARK'), 1, 'the reply the old outbox owed lands once');
    A.ok(sends().some(c => String(c.fields.text).indexOf(HEADER) === 0 && String(c.fields.text).indexOf('QUEUED_ANSWER_MARK') >= 0), 'and still says it is a delayed reply');
    A.eq(landed('HELD_ANSWER_MARK'), 1, 'the finished answer the old inbox held lands once');
    A.eq(asked('ANSWERED_MARK what was it'), 0, 'and its message is not run again');
    A.eq(asked('NEVER_RAN_MARK'), 1, 'a message that never reached a run replays once');
    A.eq(landed('REPLAYED_ANSWER_MARK'), 1, 'and is answered once');
    A.eq(asked('STEPS_BEGUN_MARK'), 0, 'a message whose run had begun tool steps is never run again');
    A.eq(landed('NOT run again'), 1, 'the chat gets one notice instead');

    const ledger = (() => { try { return JSON.parse(fs.readFileSync(file('delivery.json'), 'utf8')); } catch (_) { return { receipts: [null], deliveries: [null], migrated: { inbox: [], outbox: [] } }; } })();
    A.eq([ledger.receipts.length, ledger.deliveries.length], [0, 0], 'channels/delivery.json exists and owes nothing any more');
    A.eq(ledger.migrated.outbox.length, 1, 'and remembers what it took from the outbox');
    A.eq(ledger.migrated.inbox.length, 3, 'and from the inbox');
    const empty = { version: 1, items: [] };
    for (const name of ['inbox.json', 'inbox.json.bak', 'outbox.json', 'outbox.json.bak']) {
      A.eq(JSON.parse(fs.readFileSync(file(name), 'utf8')), empty, name + ' is a valid empty envelope: an older build replays and resends nothing');
    }

    // a restart over the migrated workspace: Telegram reconnects from its saved config, and nothing is owed
    const before = { sends: sends().length, runs: runs().length };
    await sidecar.stop();
    await sidecar.start();
    await waitFor(up, 30000, 'Telegram to reconnect after the restart');
    await sleep(3000);
    A.eq(sends().length, before.sends, 'the restart sends nothing');
    A.eq(runs().length, before.runs, 'and runs nothing');

    // the station still works on the ledger it migrated to: the owner pairs and a new message is answered once
    const pair = await sidecar.json('POST', '/api/channels/telegram/owner/pair', {});
    A.ok(pair.body && pair.body.code, 'a one-time owner pairing code');
    telegram.pushText(CHAT, CHAT, '/pair ' + pair.body.code);
    await waitFor(() => sends().some(c => /Owner paired/i.test(String(c.fields.text || ''))), 15000, 'the owner pairing acknowledgement');
    telegram.pushText(CHAT, CHAT, 'NEVER_RAN_MARK and once more');
    await waitFor(() => landed('REPLAYED_ANSWER_MARK') >= 2, 20000, 'a new message to be answered');
    A.eq(landed('REPLAYED_ANSWER_MARK'), 2, 'a new message is answered once, on the migrated ledger');
  } catch (error) {
    error.message += '\nBot API calls:\n' + telegram.calls.map(c => '  ' + c.method + ' ' + JSON.stringify(c.fields).slice(0, 160)).join('\n');
    error.message += '\nSidecar output (tail):\n' + sidecar.output().slice(-5000);
    throw error;
  } finally {
    await sidecar.dispose();
    await telegram.close();
    await model.close();
  }
  A.report('channels.ledger-upgrade.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
