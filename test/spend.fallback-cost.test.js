'use strict';
/* Production loop, summarizer/adapters and accounting. Only transport bytes are faked.
 * The paired old-source control is retained in the lane evidence report. No live billing claim. */
const assert = require('node:assert/strict');
const { from, wire, start, text, end, response } = require('./spend.compaction-accounting.test.js');
const { makeAnthropicProvider } = from('sidecar/providers/anthropic.js');
const { makeCostEngine } = from('sidecar/cost.js');
const { runAgentLoop } = from('sidecar/loop.js');
const BillingClass = from('sidecar/billing-class.js');
async function probe(overlap) {
  const A = 'fixture-outgoing-model', B = 'fixture-incoming-model';
  const calls = { a: 0, b: 0 };
  const costA = makeCostEngine({ priceOf: model => model === A ? { in: 1000, out: 1000 } : null });
  const costB = makeCostEngine({ priceOf: model => model === B ? { in: 2000, out: 3000 }
    : overlap && model === A ? { in: 9000, out: 9000 } : null });
  const billing = BillingClass.makeBilling({ profileOf: () => ({ unmetered: false, authType: 'key' }) });
  const adapter = route => makeAnthropicProvider({ key: 'fixture-key-' + route,
    baseUrl: 'https://fallback-' + route + '.invalid', reasoningEffort: 'none', fetch: async (url, init) => {
      assert.ok(String(url).startsWith('https://fallback-' + route + '.invalid/'));
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = JSON.parse(init.body);
      calls[route]++;
      assert.equal(body.model, route === 'a' ? A : B, 'actual route/model request');
      assert.ok(calls[route] <= 2, 'bounded fixture requests');
      if (route === 'a') return response([wire(start('fallback_a_' + overlap, 100)), wire({ type: 'error',
        error: { type: 'overloaded_error', message: 'fixture upstream overload after usage' } })]);
      return response([wire(start('fallback_b_' + overlap, 20)),
        wire(text('Finished on the second route.')) + wire(end(5)) + wire({ type: 'message_stop' })]);
    } });
  const r = await runAgentLoop({ provider: adapter('a'), cost: costA, model: A,
    billingClassOf: billing.classifierFor('a'),
    fallbacks: [{ provider: adapter('b'), cost: costB, model: B, billingClassOf: billing.classifierFor('b') }],
    messages: [{ role: 'user', content: 'Give the fixture answer.' }],
    agentId: 'probe', runId: 'fallback-cost-' + overlap, limits: { maxIters: 2, grace: false },
    emit: () => {}, sleep: async () => {}, random: () => 0.5, waitTicker: () => () => {} });
  assert.deepEqual(calls, { a: 1, b: 1 }, 'one outgoing partial attempt and one incoming success');
  assert.equal(r.reason, 'done', 'the permitted fallback completes');
  const expectedA = costA.reconcile({ prompt_tokens: 100, completion_tokens: 0 }, A).usd;
  const expectedB = costB.reconcile({ prompt_tokens: 20, completion_tokens: 5 }, B).usd;
  assert.ok(expectedA > 0 && expectedB > 0, 'both fixtures have real positive catalog floors');
  assert.ok(Math.abs(r.usd - expectedA - expectedB) < 1e-9,
    'outgoing usage uses its own cost snapshot: got ' + r.usd + ', expected ' + (expectedA + expectedB));
  assert.equal(r.tokens, 125, 'both attempts counted exactly once');
  assert.deepEqual(r.unpricedUsage, [], 'priced outgoing model never becomes unpriced in incoming catalog');
  assert.deepEqual(r.generationIds, ['fallback_a_' + overlap, 'fallback_b_' + overlap], 'receipt order matches actual attempts');
  return { overlap, calls, usd: r.usd, expectedA, expectedB };
}
if (require.main === module) (async () => {
  for (const overlap of [false, true]) console.log(JSON.stringify(await probe(overlap)));
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
module.exports = { probe };
