'use strict';
/* The real provider request after a named internal run and restart must replay owner dialogue only. */
const assert = require('node:assert/strict');
const http = require('node:http');
const UserText = require('../frontend/app/usertext.js');
const messageText = message => UserText.flatten(message && message.content, UserText.OPENAI);
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const upstream = [];
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', data => { raw += data; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); return; }
    upstream.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'REPLAY_FIXTURE_ANSWER' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'selftalk-replay-', timeoutMs: 20000, env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_TURNID_REPLAY: process.env.TURN_REPLAY_CONTROL === 'legacy' ? 'legacy' : 'id'
  } });
  async function run(text, internal) {
    const response = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent',
      streamId: 'projection-fixture', internal: !!internal, isTask: false, messages: [{ role: 'user', content: text }] });
    assert.equal(response.status, 200);
    const events = String(response.body).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert(events.some(event => event.name === 'agent.run.end'), 'real run reaches its terminal event');
    const requests = upstream.filter(body => Array.isArray(body.messages) && body.messages.some(message => message.role === 'user' && messageText(message).includes(text)));
    assert(requests.length, 'actual upstream request was recorded: ' + JSON.stringify({
      terminal: events.filter(event => /agent\.run\.(?:end|error)/.test(event.name)).map(event => event.payload),
      requests: upstream.slice(-2).map(body => (body.messages || []).map(message => ({ role: message.role, text: messageText(message).slice(0, 200) })))
    }));
    return requests[requests.length - 1];
  }
  try {
    await fixture.start();
    await run('OWNER_BEFORE_RESTART repair reconnect', false);
    await run('INTERNAL_ARBITRARY_SENTINEL not a known title or goal prefix', true);
    let next = await run('OWNER_AFTER_INTERNAL continue the repair', false);
    assert(next.messages.some(message => messageText(message).includes('OWNER_BEFORE_RESTART')), 'new request resumes actual earlier owner dialogue');
    assert(!next.messages.some(message => messageText(message).includes('INTERNAL_ARBITRARY_SENTINEL')), 'named internal call is absent from actual provider replay');
    await fixture.restart();
    next = await run('OWNER_AFTER_RESTART finish the repair', false);
    assert(next.messages.some(message => messageText(message).includes('OWNER_AFTER_INTERNAL')), 'restart retains owner replay');
    assert(!next.messages.some(message => messageText(message).includes('INTERNAL_ARBITRARY_SENTINEL')), 'restart cannot resurrect internal replay');
    const diagnostic = await fixture.json('GET', '/api/transcript?stream=projection-fixture&view=model-replay');
    assert.equal(diagnostic.status, 200);
    assert(diagnostic.body.turns.length > 0 && diagnostic.body.turns.every(row => Number.isSafeInteger(row.rowId) && row.rowId > 0), 'diagnostic view exposes real durable IDs');
    assert(!diagnostic.body.turns.some(row => String(row.content).includes('INTERNAL_ARBITRARY_SENTINEL')), 'diagnostic route uses the same replay visibility');
    console.log('selftalk-replay.http: provider replay and diagnostic rows exclude internal work before/after restart PASS');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
