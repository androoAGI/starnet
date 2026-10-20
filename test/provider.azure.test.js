'use strict';
const assert = require('node:assert/strict');
const { normalizeEndpoint, validateDeployment } = require('../sidecar/providers/azure-foundry.js');
const { selectProvider, normalizeProviderId } = require('../sidecar/providers/factory.js');

(async () => {
  assert.equal(normalizeProviderId('azure-foundry'), 'azure');
  for (const host of ['demo.openai.azure.com', 'demo.services.ai.azure.com']) {
    for (const suffix of ['', '/', '/openai/', '/openai/v1/']) {
      assert.equal(normalizeEndpoint('https://' + host + suffix), 'https://' + host + '/openai/v1');
    }
  }
  for (const bad of ['', 'http://example.com', 'https://user:key@example.com', 'https://example.com?api-key=secret', 'https://example.com/#secret', 'https://example.com/api/projects/demo', 'https://example.com/openai/deployments/demo']) {
    assert.throws(() => normalizeEndpoint(bad));
  }
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, ...init });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'base-model' }] });
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"OK"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const adapter = selectProvider({ provider: 'azure', key: 'test-only-key', baseUrl: 'https://demo.services.ai.azure.com/', fetch: fakeFetch });
  await adapter.listModels();
  const events = [];
  for await (const event of adapter.stream({ model: 'my-deployment', messages: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }] })) events.push(event);
  assert.ok(events.some(e => e.type === 'text' && e.delta === 'Hello'));
  assert.ok(events.some(e => e.type === 'tool_start' && e.name === 'echo'));
  const chat = seen.find(r => r.method === 'POST');
  assert.equal(chat.url, 'https://demo.services.ai.azure.com/openai/v1/chat/completions');
  assert.equal(JSON.parse(chat.body).model, 'my-deployment');
  for (const request of seen) {
    assert.equal(request.headers['api-key'], 'test-only-key');
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.redirect, 'error');
  }
  // The adapter's global-fetch fallback must refuse redirects just like an injected fetch.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch;
    await selectProvider({ provider: 'azure', key: 'test-only-key', baseUrl: 'https://demo.openai.azure.com' }).listModels();
    assert.equal(seen.at(-1).redirect, 'error');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(adapter.priceOf('arbitrary-enterprise-deployment'), null, 'enterprise pricing is not guessed from public OpenAI rates');
  let checked = false;
  await validateDeployment({ baseUrl: 'https://demo.openai.azure.com', key: 'test-key', model: 'my-deployment', fetch: async (url, init) => {
    checked = true;
    assert.equal(init.headers['api-key'], 'test-key');
    assert.equal(JSON.parse(init.body).model, 'my-deployment');
    assert.equal(JSON.parse(init.body).max_completion_tokens, 16);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  } });
  assert.ok(checked);
  await assert.rejects(validateDeployment({ baseUrl: 'https://demo.openai.azure.com', key: 'test-key', model: '', fetch: fakeFetch }), /deployment name/);
  await assert.rejects(validateDeployment({ baseUrl: 'https://demo.openai.azure.com', key: 'test-key', model: 'wrong', fetch: async () => new Response('secret upstream error', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(validateDeployment({ baseUrl: 'https://demo.openai.azure.com', key: 'test-key', model: 'wrong', fetch: async () => Response.json({ choices: [] }) }), /not verified/);
  console.log('provider.azure.test: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
