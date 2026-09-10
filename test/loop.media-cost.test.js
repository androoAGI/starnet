'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

test('tool charges survive cancellation/failure and count toward the next budget guard', async () => {
  for (const mode of ['budget', 'cancel', 'failure']) {
    const pending = [], events = [], ac = new AbortController();
    let calls = 0;
    const provider = { async *stream() {
      calls++;
      yield { type: 'tool_start', index: 0, id: 'image1', name: 'image_generate' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { cost: 0 } };
      yield { type: 'done', finishReason: 'tool_calls' };
    } };
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'create image' }], provider,
      emit: (name, payload) => events.push({ name, payload }), cost: makeCostEngine(),
      model: 'text/model', agentId: 'a', runId: 'r', signal: ac.signal,
      limits: { maxIters: 3, maxCostUsd: .02 },
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' },
      drainToolCosts: () => pending.splice(0),
      dispatch: async () => {
        pending.push({ model: 'image/model', usd: .025, tokensIn: 4, tokensOut: 2 });
        if (mode === 'cancel') ac.abort();
        if (mode === 'failure') { const e = Error('durability boundary'); e.fatalToRun = true; throw e; }
        return { ok: true, content: 'saved', summary: 'image' };
      }
    });
    assert.equal(result.reason, mode === 'cancel' ? 'cancelled' : mode === 'failure' ? 'error' : 'budget');
    assert.equal(result.usd, .025);
    assert.equal(calls, 1, 'no new inference after the image exhausts the configured cap');
    const media = events.filter(e => e.name === 'agent.cost' && e.payload.model === 'image/model');
    assert.equal(media.length, 1, 'single charge despite both dispatch-finally and terminal settlement');
    assert.equal(media[0].payload.tokensIn, undefined, 'auxiliary tokens never replace conversation occupancy');
  }
});
