'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeResponsesGatewayProvider } = require('../sidecar/providers/responses-gateway');
test('Responses gateway uses only its live catalogue and preserves max/ultra through the Responses decoder', async () => {
  const requests = [];
  const provider = makeResponsesGatewayProvider({ key: 'test-only', fetch: async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'luna', recommended: true, allowed_reasoning_efforts: ['medium', 'max', 'ultra'] }, { id: 'disabled', available: false }] });
    return new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Done' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) + '\n\n');
  } });
  assert.deepEqual((await provider.listModels()).map(m => m.id), ['luna']);
  for (const effort of ['max', 'ultra']) {
    const events = [];
    for await (const event of provider.stream({ model: 'luna', reasoningEffort: effort, messages: [{ role: 'user', content: 'test' }] })) events.push(event);
    assert.equal(events.find(e => e.type === 'text').delta, 'Done');
    const request = requests.at(-1);
    assert.match(request.url, /\/responses$/); assert.equal(JSON.parse(request.opts.body).reasoning.effort, effort);
  }
  const denied = makeResponsesGatewayProvider({ key: 'test', fetch: async () => new Response('', { status: 401 }) });
  await assert.rejects(denied.listModels(), /401/);
});
function fixture(fetch) {
  const data = new Map(), localStorage = { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  const context = vm.createContext({ console, fetch, localStorage, AbortController, crypto: require('node:crypto').webcrypto,
    setTimeout, clearTimeout, Save: { CURRENT: 5 }, module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/cloudsave.js'), 'utf8'), context);
  return { api: context.module.exports, localStorage };
}
test('remote refresh respects drafts, dirty saves, newer schemas, and edits arriving during the read', async () => {
  const base = { schema: 'starnet.save', version: 5, agent: { id: 'agent' }, _saveRevision: 1 };
  let next = { ...base, _saveRevision: 2 }, release, delayed = false;
  const { api, localStorage } = fixture(async () => { if (delayed) await new Promise(r => release = r); return Response.json({ save: next }); });
  localStorage.setItem('starnet.save', JSON.stringify(base));
  assert.equal(await api.refreshRemote(() => false), null);
  assert.equal((await api.refreshRemote())._saveRevision, 2);
  assert.equal(api.revision(), 2);
  next = { ...base, _saveRevision: 3, version: 99 };
  assert.equal(await api.refreshRemote(), null); assert.equal(api.revision(), 2);
  next = { ...base, _saveRevision: 3 }; delayed = true;
  let safe = true; const pending = api.refreshRemote(() => safe); safe = false; release();
  assert.equal(await pending, null); assert.equal(api.revision(), 2);
  delayed = false; localStorage.setItem('starnet.save', JSON.stringify({ ...base, _saveDirty: true }));
  assert.equal(await api.refreshRemote(), null);
});
test('Mac harness selects the server-held provider and launches with an ID, without copying a key', async () => {
  const cache = new Map(), calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/providers') return Response.json({ providers: [{ id: 'gateway', configured: true }] });
    if (url === '/api/run') return new Response([
      { name: 'agent.run.start', payload: { runId: 'test-run', agentId: 'agent', model: 'luna' } },
      { name: 'agent.token', payload: { runId: 'test-run', delta: 'Done' } },
      { name: 'agent.run.end', payload: { runId: 'test-run', reason: 'done' } }
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    return Response.json({ configured: false });
  };
  const context = vm.createContext({ window: { __STARNET_REMOTE__: true, __STARNET_API_TOKEN__: 'test-only' },
    location: { origin: 'http://127.0.0.1:8790' }, console, fetch: fetcher, crypto: require('node:crypto').webcrypto,
    TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    localStorage: { getItem: k => cache.get(k) || null, setItem: (k,v) => cache.set(k,v), removeItem: k => cache.delete(k) } });
  const harness = vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8') + '\nHarness', context);
  await harness.init();
  assert.equal(harness.getProv(), 'gateway'); assert.equal(harness.configured('gateway'), true);
  assert.equal(harness.getKey('gateway'), '');
  harness.setModel('luna');
  const result = await harness.chat({ messages: [{ role: 'user', content: 'test' }] });
  assert.equal(result.text, 'Done');
  const request = JSON.parse(calls.find(c => c.url === '/api/run').options.body);
  assert.match(request.requestId, /^[a-f0-9-]{36}$/); assert.equal(request.key, '');
});

test('gateway catalog metadata cannot invent reasoning levels or free billing', async () => {
  const provider = makeResponsesGatewayProvider({ key: 'fixture', fetch: async () => Response.json({ data: [
    null, { id: '' }, { id: 'text-only', supports_tools: false, allowed_reasoning_efforts: ['medium', 'invalid'], default_reasoning_effort: 'invalid' }
  ] }) });
  const models = await provider.listModels();
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].reasoningEfforts, ['medium']);
  assert.equal(models[0].defaultReasoningLevel, 'medium');
  assert.equal(provider.supportsTools('text-only'), false);
  assert.equal(models[0].pricing, null);
  const profile = require('../sidecar/providers/registry').getProviderProfile('gateway');
  assert.notEqual(profile.unmetered, true);
  const broken = makeResponsesGatewayProvider({ key: 'fixture', fetch: async () => Response.json({ error: 'unavailable' }) });
  await assert.rejects(broken.listModels(), /invalid model catalogue/);
});
