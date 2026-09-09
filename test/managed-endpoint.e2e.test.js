'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
test('managed chat ignores stale request endpoints and credentials across provider switch and restart', { timeout: 120000 }, async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: 100 }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (/\/(debit|credit)$/.test(req.url)) return res.end(JSON.stringify({ ok: true, balanceUsd: 100 }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    calls.push({ url: req.url, key: req.headers.authorization });
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Managed connection works.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cloud = 'http://127.0.0.1:' + server.address().port;
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const stale = 'http://127.0.0.1:' + closed.address().port + '/v1';
  await new Promise(r => closed.close(r));
  const fixture = new SidecarFixture({ prefix: 'managed-endpoint-proof-', timeoutMs: 20000, env: {
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CLOUD_URL: cloud, STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    OPENROUTER_API_KEY: '', OPENROUTER_KEY: '', SKYNET_AUX_BUDGET: '0', SKYNET_FULL_ACCESS: '1'
  } });
  const savedPath = path.join(fixture.workspace, '.secrets/credits.json');
  fs.mkdirSync(path.dirname(savedPath), { recursive: true });
  fs.writeFileSync(savedPath, JSON.stringify({ url: cloud, deviceToken: 'fixture-linked-token', accountId: 'fixture-account', linkedAt: Date.now() }));
  async function run(provider, overrides = {}) {
    const response = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model: 'test/model', agentId: 'endpoint-proof', messages: [{ role: 'user', content: 'Say hello' }], ...overrides }) });
    assert.equal(response.status, 200);
    return (await response.text()).split('\n').filter(Boolean).map(JSON.parse);
  }
  function done(events) { assert.equal(events.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done', JSON.stringify(events.filter(e => /error/.test(e.name)))); }
  try {
    await fixture.start();
    done(await run('starnet'));
    const reproduction = await run('starnet', { baseUrl: stale });
    if (process.env.ENDPOINT_BASELINE === '1') {
      assert.match(JSON.stringify(reproduction), /ECONNREFUSED 127\.0\.0\.1/);
      console.log('BEFORE: linked managed chat succeeds; stale request endpoint reproduces fetch failed (ECONNREFUSED 127.0.0.1).');
      return;
    }
    done(reproduction);
    for (const round of [0, 1]) {
      if (round) {
        const link = JSON.parse(fs.readFileSync(savedPath, 'utf8')); delete link.deviceToken;
        fs.writeFileSync(savedPath, JSON.stringify(link));
        await fixture.restart({ STARNET_CREDITS_TOKEN: 'fixture-linked-token' });
      }
      done(await run('custom', { baseUrl: cloud + '/custom/v1', key: 'fixture-custom-key' }));
      assert.equal(calls.at(-1).key, 'Bearer fixture-custom-key');
      assert.equal(calls.at(-1).url, '/custom/v1/chat/completions');
      done(await run('starnet', { base_url: stale, key: 'fixture-custom-key' }));
      assert.equal(calls.at(-1).key, 'Bearer fixture-linked-token');
      assert.equal(calls.at(-1).url, '/v1/chat/completions');
    }
    // Without a linked account, arbitrary request credentials must not impersonate managed access.
    fs.unlinkSync(savedPath);
    await fixture.restart({ STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '' });
    const beforeUnlinked = calls.length;
    const unlinked = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'starnet', key: 'fixture-custom-key', baseUrl: cloud + '/v1', model: 'test/model', messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(unlinked.status, 400);
    assert.equal(calls.length, beforeUnlinked, 'unlinked managed request must not reach a provider');
    console.log('AFTER: stale endpoint repaired; custom routing preserved; switching back uses linked endpoint/token; desktop-token restart passed.');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('persisted frontend endpoints stay provider scoped across switching and reload', async () => {
  const vm = require('node:vm');
  const values = new Map();
  const localStorage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
  const load = () => {
    const context = { localStorage, console, window: {}, location: { search: '', origin: 'http://127.0.0.1:8787' }, URLSearchParams, URL, AbortController, setTimeout, clearTimeout };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/app/harness.js'), 'utf8') + ';globalThis.h=Harness;', context);
    return context.h;
  };
  let harness = load();
  await harness.setBaseUrl('http://127.0.0.1:9/v1', 'custom');
  harness.setProv('gemini'); assert.equal(harness.getBaseUrl('gemini'), '');
  harness.setProv('starnet'); assert.equal(harness.getBaseUrl('starnet'), '', 'normal switching does not explain a managed override');
  // A pre-existing managed-scoped override DOES survive reload and is sent by the existing frontend.
  await harness.setBaseUrl('http://127.0.0.1:9/v1', 'starnet');
  harness = load();
  assert.equal(harness.getBaseUrl('starnet'), 'http://127.0.0.1:9/v1');
  assert.equal(harness.getBaseUrl('custom'), 'http://127.0.0.1:9/v1');
  assert.equal(harness.getBaseUrl('gemini'), '');
});
