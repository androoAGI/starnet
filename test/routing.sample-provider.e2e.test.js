'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

test('sample uses each dock provider and saved model without environment defaults, including restart', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        calls.push({ model: body.model, auth: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Sample complete.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/models') ? { data: [
      { id: 'openai/gpt-5.6-sol', context_length: 8000 }, { id: 'hop-model', context_length: 8000 }
    ] } : { ok: true, balanceUsd: 100 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'sample-provider-', timeoutMs: 20000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    STARNET_OPENROUTER_BASE: base + '/v1', SKYNET_OPENROUTER_BASE: base + '/v1',
    STARNET_CREDITS_URL: base, STARNET_CREDITS_API_KEY: 'managed-fixture', STARNET_CREDITS_ACCOUNT: 'fixture',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  try {
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const agents = [
      { agentId: 'entry', name: 'Entry', system: 'Sample', provider: 'starnet', model: 'openai/gpt-5.6-sol' },
      { agentId: 'hop', name: 'Hop', system: 'Sample', provider: 'custom', model: 'hop-model' }
    ];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    await publishFloor(fixture, floorOf({ props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'a', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'entry' },
      { id: 'b', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'hop' },
      { id: 'o', t: 'outbox', x: 9, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5, 7, 8].map(x => ({ x, y: 0, dir: 'E' })) }));
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await fixture.restart();
      calls.length = 0;
      const result = await fixture.json('POST', '/api/routing/sample', {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.delivered.agentId, 'hop');
      assert.equal(result.body.runs.length, 2);
      assert.ok(calls.some(c => c.model === agents[0].model && c.auth === 'Bearer managed-fixture'));
      assert.ok(calls.some(c => c.model === agents[1].model && c.auth === 'Bearer direct-fixture'));
      assert.ok(calls.every(c => (c.model === agents[0].model ? c.auth === 'Bearer managed-fixture' : c.auth === 'Bearer direct-fixture')));
    }
    agents[0].model = '';
    await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() });
    calls.length = 0;
    const refused = await fixture.json('POST', '/api/routing/sample', {});
    assert.equal(refused.body.ok, false);
    assert.equal(calls.length, 0, 'missing roster model cannot spend a different provider credential');

    // "Follow station default": an unpinned specialist runs on the OVERSEER's model and provider (what COMMS
    // resolves), never on a stale provider its row still carries (the #24 leak shape) and never refused outright.
    const station = [
      { agentId: 'agent', name: 'Overseer', system: 'Sample', provider: 'custom', model: 'hop-model' },
      { agentId: 'scout', name: 'Scout', system: 'Sample', provider: 'starnet', model: '' }
    ];
    assert.equal((await fixture.json('POST', '/api/roster', { agents: station, updatedAt: Date.now() })).status, 200);
    await publishFloor(fixture, floorOf({ props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 's', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'scout' },
      { id: 'o', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }));
    calls.length = 0;
    const followed = await fixture.json('POST', '/api/routing/sample', {});
    assert.equal(followed.status, 200, JSON.stringify(followed.body));
    assert.equal(followed.body.delivered.agentId, 'scout', 'the unpinned specialist runs its own bay');
    assert.ok(calls.length > 0 && calls.every(c => c.model === 'hop-model' && c.auth === 'Bearer direct-fixture'),
      'the unpinned specialist runs on the Overseer model and credential, not its stale starnet row: ' + JSON.stringify(calls));
  } finally {
    await fixture.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
