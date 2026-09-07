'use strict';
// A retry is another execution of the same durable user turn; identical new sends remain distinct.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
let fail = true;
const requests = [];
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); return; }
    const body = JSON.parse(raw); requests.push(body);
    if (fail) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 401, message: 'Invalid API key fixture' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'RECOVERED' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ entry: process.env.STARNET_RETRY_TEST_ENTRY, prefix: 'retry-transcript-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'fixture', STARNET_OPENROUTER_KEY: 'fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0'
  } });
  const text = 'RETRY_USER_IDENTITY: acknowledge this message';
  async function run(streamId, retryUserRunId, content = text) {
    const r = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent', streamId, messages: [{ role: 'user', content }], retryUserRunId });
    assert.equal(r.status, 200);
    // fixture.json retains NDJSON as text when the response is not a single JSON object.
    const events = typeof r.body === 'string' ? r.body.trim().split('\n').filter(Boolean).map(JSON.parse) : null;
    assert(events, 'run must return its actual NDJSON lifecycle');
    return events.find(e => e.name === 'agent.run.start').payload.runId;
  }
  async function users(stream) { const r = await fixture.json('GET', '/api/transcript?stream=' + stream); assert.equal(r.status, 200); return r.body.turns.filter(row => row.role === 'user'); }
  try {
    await fixture.start();
    const first = await run('retry-main'); assert.equal((await users('retry-main')).length, 1);
    fail = false;
    await run('retry-main', first);
    assert.equal((await users('retry-main')).length, 1, 'successful retry must reuse the original user row');
    assert.equal(requests.filter(r => r.messages.some(m => m.role === 'user' && m.content === text)).at(-1).messages.filter(m => m.role === 'user' && m.content === text).length, 1, 'automatic transcript seeding must not duplicate the retried input');
    await fixture.restart();
    assert.equal((await users('retry-main')).length, 1, 'one user row survives restart');
    await run('retry-main', first);
    assert.equal((await users('retry-main')).length, 1, 'repeated retries keep the original user identity');
    await run('retry-main');
    assert.equal((await users('retry-main')).length, 2, 'an intentional identical new message must remain a separate turn');
    await run('other-stream', first);
    assert.equal((await users('other-stream')).length, 1, 'a reference from another stream cannot omit a new turn');
    await run('retry-main', first, 'DIFFERENT USER MESSAGE');
    assert.equal((await users('retry-main')).length, 3, 'changed text or an older directive cannot be silently omitted');
    await run('retry-main', { invalid: true }, 'MALFORMED RETRY REFERENCE');
    assert.equal((await users('retry-main')).length, 4, 'an invalid reference is treated as a normal new turn');
    console.log('retry-user-transcript: failure, retry, seed, repeated retry, restart, identical new messages and invalid references PASS');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });

