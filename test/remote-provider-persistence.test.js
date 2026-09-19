'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture');
const { createRemoteProviderStore } = require('../sidecar/remote-provider-store');

function harness(fetch, entries = []) {
  const cache = new Map(entries);
  const context = vm.createContext({ window: { __STARNET_REMOTE__: true }, console, fetch, AbortSignal, AbortController,
    TextDecoder, crypto: crypto.webcrypto, setTimeout, clearTimeout,
    localStorage: { getItem: k => cache.get(k) || null, setItem: (k, v) => cache.set(k, v), removeItem: k => cache.delete(k) } });
  return { cache, api: vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8') + '\nHarness', context) };
}

test('remote credentials survive restart and quota exhaustion, with no credential readback or unauthenticated writes', { timeout: 30000 }, async () => {
  let calls = 0;
  const provider = http.createServer((req, res) => { calls++; res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Quota exhausted', code: 'usage_limit_reached' } })); });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const fixture = SidecarFixture.create({ timeoutMs: 15000, env: {
    STARNET_REMOTE: '1', STARNET_ENV_DISCOVERY: '0', SKYNET_ENV_DISCOVERY: '0',
    SKYNET_SCOUT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_QUEST_REFRESH: '0'
  } });
  try {
    await fixture.start();
    const save = body => fixture.json('POST', '/api/providers/config', body);
    const denied = await fetch(fixture.baseUrl + '/api/providers/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'custom', key: 'attacker' }) });
    assert.equal(denied.status, 403);
    const key = 'synthetic-custom-secret', other = 'synthetic-second-secret';
    let r = await save({ provider: 'custom', key, baseUrl: endpoint, keyPool: ['synthetic-backup'] });
    assert.equal(r.status, 200, r.text); assert.ok(!r.text.includes(key));
    assert.equal((await save({ provider: 'openai', key: other })).status, 200);
    assert.equal(calls, 0, 'storing known credentials does not require external quota or validation');
    await fixture.restart();
    const providers = await fixture.json('GET', '/api/providers');
    assert.ok(!providers.text.includes(key) && !providers.text.includes(other));
    const rows = JSON.parse(providers.text).providers;
    assert.equal(rows.find(p => p.id === 'custom').currentBaseUrl, endpoint);
    assert.equal(rows.find(p => p.id === 'custom').credentialStored, true);
    assert.equal(rows.find(p => p.id === 'custom').alternateCount, 1);
    assert.equal(rows.find(p => p.id === 'openai').configured, true);
    assert.equal(calls, 0, 'boot and provider status never contact quota-limited endpoints');
    const probe = await fixture.json('POST', '/api/providers/probe', { provider: 'custom' });
    assert.equal(probe.status, 200); assert.ok(calls > 0);
    assert.equal(JSON.parse((await fixture.json('GET', '/api/providers')).text).providers.find(p => p.id === 'custom').credentialStored, true, 'failed probe keeps credentials');
    // Deliberate removal masks an environment/default credential and cannot be undone by an old viewer.
    assert.equal((await save({ provider: 'custom', key: '', keyPool: [] })).status, 200);
    await save({ provider: 'custom', key, migrate: true });
    await fixture.restart();
    const current = JSON.parse((await fixture.json('GET', '/api/providers')).text).providers.find(p => p.id === 'custom');
    assert.equal(current.credentialStored, false); assert.equal(current.alternateCount, 0); assert.equal(current.currentBaseUrl, endpoint);
    const file = path.join(fixture.workspace, '.secrets/remote-providers.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal((await save({ provider: 'custom', baseUrl: 'https://user:pass@example.com/v1' })).status, 400);
    assert.equal((await save({ provider: 'codex', key: 'wrong-store' })).status, 400);
  } finally { await fixture.dispose(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});

test('failed writes keep active credentials; unreadable storage cannot be overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-provider-store-'));
  try {
    const store = createRemoteProviderStore({ fs, path, dir });
    store.update('custom', { key: 'old', baseUrl: 'https://example.com/v1' });
    const broken = createRemoteProviderStore({ fs, path, dir, write() { throw new Error('disk full'); } });
    assert.throws(() => broken.update('custom', { key: 'new' })); assert.equal(broken.get('custom').key, 'old');
    fs.writeFileSync(path.join(dir, 'remote-providers.json'), '{broken');
    const corrupt = createRemoteProviderStore({ fs, path, dir });
    assert.ok(corrupt.error()); assert.throws(() => corrupt.update('custom', { key: 'new' }));
    assert.equal(fs.readFileSync(path.join(dir, 'remote-providers.json'), 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('viewer migrates multiple providers and custom endpoint, then fresh browser uses server credentials', async () => {
  const saved = {}, requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push(url);
    const row = id => ({ id, configured: !!saved[id]?.key, credentialStored: !!saved[id]?.key, currentBaseUrl: saved[id]?.baseUrl || '', alternateCount: saved[id]?.keyPool?.length || 0 });
    if (url === '/api/providers') return Response.json({ credentialStore: 'server', providers: ['custom', 'openai'].map(row) });
    assert.equal(url, '/api/providers/config');
    const body = JSON.parse(options.body); saved[body.provider] = { ...saved[body.provider], ...body };
    return Response.json({ ok: true, ...row(body.provider) });
  };
  const first = harness(fetcher, [ ['starnet.byok.key.custom', 'custom-test'], ['starnet.byok.baseUrl.custom', 'https://example.com/v1'],
    ['starnet.byok.key.openai', 'openai-test'], ['starnet.byok.model', 'glm-private-id'], ['starnet.byok.prov', 'custom'] ]);
  await first.api.init();
  assert.equal(first.cache.has('starnet.byok.key.custom'), false); assert.equal(first.cache.has('starnet.byok.key.openai'), false);
  assert.equal(first.api.getKey('custom'), ''); assert.equal(first.api.hasStoredCredential('custom'), true);
  assert.equal(first.api.getBaseUrl('custom'), 'https://example.com/v1'); assert.equal(first.api.getModel(), 'glm-private-id');
  const fresh = harness(fetcher); await fresh.api.init();
  assert.equal(fresh.api.configured('custom'), true); assert.equal(fresh.api.configured('openai'), true); assert.equal(fresh.api.getBaseUrl('custom'), 'https://example.com/v1');
  assert.ok(!requests.some(url => /credits|validate|probe|models/.test(url)), 'boot does not make external provider checks');
});

test('failed migration retains local keys and endpoint for retry', async () => {
  const first = harness(async url => url === '/api/providers'
    ? Response.json({ credentialStore: 'server', providers: [{ id: 'custom', configured: false }] })
    : Response.json({ error: 'disk unavailable' }, { status: 503 }),
    [['starnet.byok.key.custom', 'test-key'], ['starnet.byok.baseUrl.custom', 'https://example.com/v1']]);
  await first.api.init(); assert.equal(first.cache.get('starnet.byok.key.custom'), 'test-key');
  assert.equal(first.api.getBaseUrl('custom'), 'https://example.com/v1');
});

test('legacy gateway records migrate without losing a key or reviving a removed canonical key', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-provider-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'remote-providers.json');
  const aliases = { levserver: 'gateway' };
  fs.writeFileSync(file, JSON.stringify({ version: 1, providers: { levserver: { key: 'synthetic-legacy', baseUrl: 'http://127.0.0.1:8781/v1' } } }));
  const store = createRemoteProviderStore({ fs, path, dir, aliases });
  assert.equal(store.get('gateway').key, 'synthetic-legacy');
  store.update('gateway', { key: '' });
  assert.equal(JSON.parse(fs.readFileSync(file)).providers.levserver, undefined);
  const restarted = createRemoteProviderStore({ fs, path, dir, aliases });
  restarted.update('gateway', { key: 'stale-browser-copy' }, { migrate: true });
  assert.equal(restarted.get('gateway').key, '');
  fs.writeFileSync(file, JSON.stringify({ version: 1, providers: { levserver: { key: 'old' }, gateway: { key: '' } } }));
  assert.equal(createRemoteProviderStore({ fs, path, dir, aliases }).get('gateway').key, '');
});

test('legacy browser gateway credentials are removed only after canonical server acknowledgement', async () => {
  const entries = [['starnet.byok.prov', 'levserver'], ['starnet.byok.key.levserver', 'synthetic-old-key']];
  let saved;
  const f = harness(async (url, options) => {
    if (url === '/api/providers') return Response.json({ credentialStore: 'server', providers: [{ id: 'gateway', configured: false }] });
    saved = JSON.parse(options.body);
    return Response.json({ ok: true, provider: 'gateway', configured: true, credentialStored: true });
  }, entries);
  await f.api.init();
  assert.equal(f.api.getProv(), 'gateway');
  assert.equal(saved.provider, 'gateway');
  assert.equal(saved.key, 'synthetic-old-key');
  assert.equal(f.cache.has('starnet.byok.key.levserver'), false);
});
