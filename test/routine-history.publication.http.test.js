'use strict';
/* Real host admission, routine execution, channel transport, strict publication and
   restart recovery. Only the provider/Telegram network, one filesystem failure and
   the restarted child's wall clock are controlled. No durable receipts are rewritten. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Kinds = require('../frontend/app/turnkinds.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const HOST = '127.0.0.1', CHAT = '4242', STREAM = 'publication_original';
const ANSWER = 'PUBLICATION_HTTP_COMPLETE_RESULT';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(80); }
  throw new Error('timed out waiting for ' + label);
}
(async () => {
  const requests = [], sends = [];
  let fixture;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', part => { raw += part; }); req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
      const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url.includes('/models')) return reply({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] });
      if (req.url.includes('/chat/completions')) {
        requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\ndata: [DONE]\n\n'); return;
      }
      const method = String(req.url).split('?')[0].split('/').pop();
      if (method === 'getMe') return reply({ ok: true, result: { id: 42, is_bot: true, username: 'publication_bot', first_name: 'Publication' } });
      if (method === 'getUpdates') return setTimeout(() => { if (!res.writableEnded) reply({ ok: true, result: [] }); }, 200);
      if (method === 'sendMessage') {
        const ledger = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'channels', 'delivery.json'), 'utf8'));
        sends.push({ body, records: ledger.deliveries });
        return reply({ ok: true, result: { message_id: 100 + sends.length, chat: { id: Number(body.chat_id) } } });
      }
      reply({ ok: true, result: true });
    });
  });
  await new Promise(resolve => server.listen(0, HOST, resolve));
  const base = 'http://' + HOST + ':' + server.address().port;
  fixture = SidecarFixture.create({ prefix: 'routine-publication-http-', env: {
    STARNET_TELEGRAM_API_BASE: base, SKYNET_TELEGRAM_API_BASE: base,
    STARNET_OPENROUTER_BASE: base + '/api/v1', SKYNET_OPENROUTER_BASE: base + '/api/v1',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-publication-fixture', SKYNET_OPENROUTER_KEY: 'sk-or-v1-publication-fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_CRON_TICK_MS: '1500', SKYNET_CRON_TICK_MS: '1500', SKYNET_AUX_BUDGET: '0',
    SKYNET_QUEST_REFRESH_MS: '0', SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0', SKYNET_REFLECT: '0',
    NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'fixtures', 'routine-publication-fault.cjs'))
  } });
  const cronFile = path.join(fixture.workspace, 'cron.jobs.json');
  const ledgerFile = path.join(fixture.workspace, 'channels', 'delivery.json');
  const arm = path.join(fixture.workspace, 'publication-fault.arm');
  const observed = path.join(fixture.workspace, 'publication-fault-observed.jsonl');
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const diskRows = () => {
    const dir = path.join(fixture.workspace, 'transcript-history-v2');
    return fs.readdirSync(dir).filter(name => /^segment-\d+\.jsonl$/.test(name)).sort()
      .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  };
  try {
    await fixture.start();
    const connected = await fixture.json('POST', '/api/channels/telegram/connect', { token: '123456:TESTTOKEN', key: 'sk-or-v1-publication-fixture',
      model: 'test/model', provider: 'openrouter', agentId: 'agent', agentName: 'Publication', system: 'Answer the supplied request.' });
    A.eq(connected.status, 200, 'actual Telegram host connects');
    await until(async () => (await fixture.json('GET', '/api/channels/telegram/status')).body.connected, 'Telegram connected');
    const handoff = await fixture.json('POST', '/api/channels/handoff', { channel: 'telegram', chatId: CHAT, streamId: STREAM, agentId: 'agent' });
    A.eq(handoff.status, 200, 'authenticated handoff binds the actual channel owner');
    A.eq(handoff.body.historyAvailable, true, 'canonical context is actually provable before transport');
    const created = await fixture.json('POST', '/api/cron', { name: 'Publication proof', prompt: 'Write the publication fixture result.', schedule: 'every 24h',
      agentId: 'agent', model: 'test/model', provider: 'openrouter', attachToSession: true, deliver: 'origin', origin: { channel: 'telegram', chatId: CHAT }, arm: true });
    A.eq(created.status, 200, 'actual host creates attached routine');
    A.ok(!!created.body.job?.id, 'actual routine has durable identity');
    const jobId = created.body.job.id;
    const savedJob = () => JSON.parse(fs.readFileSync(cronFile, 'utf8')).jobs.find(job => job.id === jobId);
    fs.writeFileSync(arm, 'refuse exact canonical delivery');
    const run = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
    A.eq(run.status, 200, 'Run Now enters actual routine owner');
    const events = (await run.text()).split('\n').filter(Boolean).map(JSON.parse);
    const start = events.find(event => event.name === 'agent.run.start' && !event.payload.parentRunId)?.payload;
    const end = events.find(event => event.name === 'agent.run.end' && event.payload.runId === start?.runId)?.payload;
    A.ok(!!start && !!end && RunOutcome.ofEnd(end).ok, 'actual paid-work path ends successfully before publication failure');
    const failed = await until(() => fs.existsSync(observed) && savedJob().lastDeliveryOk === false && savedJob().finalization, 'strict publication failure recorded');
    const runId = failed.runId, recordId = 'routine:' + jobId + ':' + runId + ':@origin';
    A.eq(runId, start.runId, 'transport publication and Run Now retain the same run identity');
    const before = ledger().deliveries.find(record => record.id === recordId);
    A.eq(before?.state, 'done', 'transport-complete record survives failed canonical write');
    A.eq(before?.historyDestination, { v: 1, streamId: STREAM, jobId, target: '@origin' }, 'actual host captured the original destination before transport');
    A.eq(sends.length, 1, 'actual transport sent exactly one result');
    A.eq(sends[0].records.find(record => record.id === recordId)?.historyDestination, before.historyDestination, 'captured binding was durable before Bot API received the result');
    A.eq(diskRows().filter(row => row.streamId === STREAM && row.kind === 'delivery').length, 0, 'failed strict write left no canonical delivery bytes');
    A.ok(fs.readFileSync(observed, 'utf8').split('\n').filter(Boolean).map(JSON.parse).every(row => row.runId === runId && row.streamId === STREAM), 'fault hit only the owned run and exact transcript stream');
    const paidCalls = requests.length;
    A.ok(paidCalls > 0, 'the real routine reached the local provider');
    await fixture.stop();
    const receiptBytes = fs.readFileSync(cronFile, 'utf8');
    fs.unlinkSync(arm);
    A.eq(fs.readFileSync(cronFile, 'utf8'), receiptBytes, 'fault removal never rewrites the durable retry receipt');
    await fixture.start({ STARNET_TEST_PUBLICATION_CLOCK_MS: '61000' });
    const delivered = await until(() => {
      const job = savedJob(); return job.lastDeliveryOk === true && job.finalization?.historyReleased === true && !ledger().deliveries.some(record => record.id === recordId) && job;
    }, 'restart publishes, persists cron proof and releases exact record');
    const rows = diskRows().filter(row => row.streamId === STREAM && row.kind === 'delivery');
    A.eq(rows.length, 1, 'restart publishes one canonical delivery');
    A.eq(rows[0]?.content, '✦ Publication proof\n\n' + ANSWER, 'canonical publication keeps the exact queued result');
    A.eq(rows[0]?.turnId, Kinds.runTurnId(runId), 'canonical delivery keeps deterministic turn identity');
    A.eq(rows[0]?.sourceRunId, runId, 'canonical row proves the original routine run');
    A.eq(delivered.finalization.historyPublications[0]?.rowId, rows[0]?.rowId, 'fresh cron primary receipt names the actual canonical row');
    A.eq(sends.length, 1, 'recovery never resends completed transport');
    A.eq(requests.length, paidCalls, 'recovery never reruns paid work');
    const displayed = await fixture.json('GET', '/api/transcript?stream=' + STREAM + '&limit=200');
    A.eq(displayed.status, 200, 'actual transcript route serves the recovered publication');
    A.ok(displayed.body.turns.some(row => row.rowId === rows[0].rowId && row.content.includes(ANSWER)), 'the canonical delivery is visible to the actual client reader');
    await fixture.stop(); await fixture.start({ STARNET_TEST_PUBLICATION_CLOCK_MS: '61000' });
    await until(async () => (await fixture.json('GET', '/api/cron')).body.health.lastSuccessAt, 'next restarted scheduler pass');
    A.eq(diskRows().filter(row => row.streamId === STREAM && row.kind === 'delivery').map(row => row.rowId), [rows[0].rowId], 'another restart preserves one exact delivery identity');
    A.eq([sends.length, requests.length], [1, paidCalls], 'another restart performs neither duplicate transport nor paid work');
  } catch (error) { error.message += '\nActual host output:\n' + fixture.output().slice(-12000); throw error; }
  finally { await fixture.dispose(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
  A.report('routine publication actual host');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
