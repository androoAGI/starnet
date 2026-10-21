'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeExecutor } = require('../sidecar/colony/runtime.js');
test('output-only model calls have a usable explicit output allowance, honest Go accounting, and no bypass tools', async () => {
  const attempt = { agentId: 'colony_lifestruct_research', runId: 'r1', id: 'a1', taskId: 't1', businessUnitId: 'lifestruct', stepId: 'research', roleVersion: 2,
    reserve: { usd: 0, tokens: 48000, ms: 1000 }, context: { processVersion: 1 }, images: [] };
  for (const [reason, content, finishReason, expected] of [
    ['done', '```json\n{"facts":[]}\n```', 'stop', true], ['done', 'Not JSON', 'stop', false], ['max_iters', '', 'length', false], ['done', '{"facts":[]}', 'length', false]
  ]) {
    let request;
    const execute = makeExecutor({ resolve: () => ({ ready: true, model: 'fixture/model' }), halted: () => false,
      runOnce: async o => { request = o; return { reason, finishReason, messages: [{ role: 'assistant', content }], tokens: 100, usd: 0, unpricedUsage: [{ model: 'fixture/model' }] }; } });
    const result = await execute(attempt);
    assert.equal(result.ok, expected); assert.equal(result.usage.usd, null); assert.equal(result.usage.tokens, 100);
    assert.equal(request.outputOnly, true); assert.equal(request.internal, true); assert.equal(request.colonyOutputTokenCap, 4096);
    if (finishReason === 'length') assert.equal(result.error, 'COLONY_MODEL_OUTPUT_LIMIT');
  }
});
test('larger structured outputs do not silently fall back to 4096 tokens; total-token cap still wins', async () => {
  const { runAgentLoop } = require('../sidecar/loop.js'), { makeReplayProvider } = require('../sidecar/providers/replay.js'), { makeCostEngine } = require('../sidecar/cost.js'), { makeContext } = require('../sidecar/context.js');
  for (const total of [1000, 64000]) {
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: '{}' }, { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }, { type: 'done', finishReason: 'stop' }]] });
    const stream = provider.stream.bind(provider), requests = []; provider.stream = req => { requests.push(req); return stream(req); };
    await runAgentLoop({ provider, messages: [{ role: 'user', content: 'test' }], model: 'replay/model', emit: () => {}, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), context: makeContext({ contextLimit: 128000 }), limits: { maxTotalTokens: total, maxOutputTokens: 16000, maxIters: 1, grace: false } });
    assert.equal(requests.length, 1);
    if (total === 64000) assert.equal(requests[0].maxTokens, 16000); else assert.ok(requests[0].maxTokens < total);
  }
});
