'use strict';
// Disposable housekeeping must not buy a cache write on API routes either. The request's actual
// instructions, model, effort and output allowance stay identical; foreground/tool work still caches.
const assert = require('node:assert/strict');
const { selectProvider } = require('../sidecar/providers/factory.js');
const tool = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } };
const marks = body => (JSON.stringify(body).match(/"cache_control"/g) || []).length;
const plain = value => {
  if (Array.isArray(value)) {
    if (value.length && value.every(p => p && p.type === 'text')) return value.map(p => p.text).join('');
    return value.map(plain);
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'cache_control').map(([k, v]) => [k, plain(v)]));
  return value;
};
(async () => {
  for (const route of ['anthropic', 'openrouter', 'starnet']) {
    const bodies = [];
    const provider = selectProvider({ provider: route, key: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', fetch: async (url, init) => {
      if (!init?.body) return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
      bodies.push(JSON.parse(init.body));
      const sse = route === 'anthropic'
        ? 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"choices":[{"delta":{"content":"NONE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const req = { model: route === 'anthropic' ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4.6', reasoningEffort: 'high', maxTokens: 4096,
      messages: [{ role: 'system', content: 'Keep every correction and constraint.' }, { role: 'user', content: 'Unique finished-task evidence. Extract durable preferences.' }] };
    for (const extra of [{}, { neverReread: true }, { neverReread: true, tools: [tool] }]) {
      for await (const unused of provider.stream({ ...req, ...extra })) {}
    }
    assert.equal(bodies.length, 3, route + ': three requests, no retry');
    assert.ok(marks(bodies[0]) > 0, route + ': ordinary requests retain caching');
    assert.equal(marks(bodies[1]), 0, route + ': disposable extraction buys no cache write');
    assert.deepEqual(plain(bodies[1]), plain(bodies[0]), route + ': all content and quality settings are unchanged');
    assert.ok(marks(bodies[2]) > 0, route + ': tool work keeps its reusable cache even if mislabelled');
  }
  console.log('aux-cache-policy: PASS (3 real adapters, content/model/effort/output parity)');
})().catch(e => { console.error(e); process.exitCode = 1; });
