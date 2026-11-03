'use strict';
/* Production loop, summarizer/adapters and accounting. Only transport bytes are faked.
 * The paired old-source control is retained in the lane evidence report. No live billing claim. */
const assert = require('node:assert/strict');
const H = require('./spend.compaction-accounting.test.js');
const { from, MODEL, PROMPT, wire, start, text, end, response, history } = H;
const { runAgentLoop } = from('sidecar/loop.js');
const { makeContext } = from('sidecar/context.js');
const { makeSummarizer } = from('sidecar/compaction-summarizer.js');
const { makeCostEngine } = from('sidecar/cost.js');
const { makeAnthropicProvider } = from('sidecar/providers/anthropic.js');
const BillingClass = from('sidecar/billing-class.js');

async function probe(kind, capped) {
  const subscription = kind === 'subscription';
  const ac = new AbortController();
  let compactCalls = 0, mainCalls = 0;
  const seen = [];
  const cost = makeCostEngine({ priceOf: () => subscription ? { in: 0, out: 0 } : { in: 1000, out: 1000 } });
  const billing = BillingClass.makeBilling({ profileOf: () => subscription
    ? { unmetered: true, authType: 'oauth' } : { unmetered: false, authType: 'key' } });
  const provider = makeAnthropicProvider({ key: 'fixture-key', baseUrl: 'https://compaction-admission.invalid',
    reasoningEffort: 'none', defaultContext: 1000, fetch: async (url, init) => {
      assert.ok(String(url).startsWith('https://compaction-admission.invalid/'));
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const b = JSON.parse(init.body), compact = JSON.stringify(b.system).includes('COMPACTION_PROBE');
      const n = compact ? ++compactCalls : ++mainCalls;
      assert.ok(compactCalls <= 12 && mainCalls <= 2, 'bounded fixture transport');
      const id = 'admission_' + kind + '_' + capped + '_' + (compact ? 'c' : 'm') + n;
      const first = start(id, compact ? 100 : 0);
      // Anthropic bills input_tokens fresh plus cache_read_input_tokens. The actual
      // decoder normalizes 100+900 input, 900 cached; 10 output => 200 weighted.
      if (compact && subscription) first.message.usage.cache_read_input_tokens = 900;
      seen.push(id);
      return response([wire(first), wire(text(compact ? 'Earlier fixture notes retained.' : 'Finished.')) +
        wire(end(compact ? 10 : 0)) + wire({ type: 'message_stop' })]);
    } });
  const summarize = makeSummarizer({ provider, cost, model: MODEL, signal: ac.signal,
    chunkChars: 1800, maxChunks: 8, summaryPrompt: () => PROMPT });
  const limits = { maxIters: 1, grace: false,
    maxCostUsd: subscription || !capped ? Infinity : 0.1,
    maxSubscriptionTokens: subscription && capped ? 200 : Infinity };
  const r = await runAgentLoop({ provider, cost, model: MODEL, signal: ac.signal,
    billingClassOf: billing.classifierFor('fixture-' + kind), limits,
    messages: history(), context: makeContext({ contextLimit: 1000, compactAt: 0.5, keepTailTurns: 1 }),
    summarize, microCompaction: false, agentId: 'probe', runId: 'admission-' + kind + '-' + capped,
    emit: () => {}, sleep: async () => {}, random: () => 0.5, waitTicker: () => () => {} });
  if (capped) {
    assert.equal(compactCalls, 1, kind + ': no second compaction attempt after first reaches ceiling');
    assert.equal(mainCalls, 0, kind + ': no ordinary generation after compaction reaches ceiling');
    assert.equal(r.reason, 'budget', kind + ': normal typed budget outcome');
    if (subscription) {
      assert.equal(r.subscriptionTokens, 200, '100 fresh + 900 cached/10 + 10 output');
      assert.equal(r.subscriptionCapTokens, 200, 'existing selected sign-in ceiling');
      assert.equal(r.tokens, 1010, 'real total tokens remain distinct from weighted limit');
      assert.equal(r.cachedTokens, 900, 'cache attribution survives compaction settlement');
    } else {
      assert.ok(Math.abs(r.usd - 0.11) < 1e-9, 'first completed call remains exactly booked');
    }
    assert.deepEqual(r.generationIds, [seen[0]], 'only the actual admitted call has a receipt');
  } else {
    assert.ok(compactCalls >= 2, kind + ': uncapped control really executes multiple chunks');
    assert.equal(mainCalls, 1, kind + ': uncapped control reaches ordinary generation');
    assert.equal(r.reason, 'done', kind + ': no new default restriction');
  }
  return { kind, capped, compactCalls, mainCalls, reason: r.reason, usd: r.usd };
}
if (require.main === module) (async () => {
  for (const kind of ['metered', 'subscription']) for (const capped of [true, false]) console.log(JSON.stringify(await probe(kind, capped)));
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
module.exports = { probe };
