'use strict';
/* Actual loop, summarizer, Anthropic decoder, cost engine and family pool. Only byte transport and
 * model-catalog facts are fixtures. Reservations are observed at the real request boundary. */
const assert = require('node:assert/strict');
const H = require('./spend.compaction-accounting.test.js');
const { from, MODEL, PROMPT, wire, start, text, end, response, history } = H;
const { runAgentLoop } = from('sidecar/loop.js');
const { makeContext } = from('sidecar/context.js');
const { makeSummarizer } = from('sidecar/compaction-summarizer.js');
const { makeCostEngine } = from('sidecar/cost.js');
const { makeAnthropicProvider } = from('sidecar/providers/anthropic.js');
const { makeRunSpendPool } = from('sidecar/run-spend-pool.js');
const AUX = 'fixture-expensive-summary';

async function probe(kind) {
  const pool = makeRunSpendPool({ capUsd: 1 }).join('leader').join('worker');
  const context = makeContext({ contextLimit: 1000, compactAt: 0.5, keepTailTurns: 1 });
  const attempts = [], observed = [];
  const free = kind === 'free', unknown = kind === 'unknown' || free;
  const priceOf = m => m === AUX ? (free ? { in: 0, out: 0 } : { in: 2000, out: 2000 }) : { in: 0.01, out: 0.01 };
  const cost = makeCostEngine({ priceOf });
  let compactCalls = 0, mainCalls = 0, heldChecks = 0;
  const provider = makeAnthropicProvider({ key: 'fixture-key', baseUrl: 'https://compaction-pool.invalid',
    maxTokens: 1000, defaultContext: 10000, reasoningEffort: 'none', fetch: async (url, init) => {
      assert.ok(String(url).startsWith('https://compaction-pool.invalid/'));
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = JSON.parse(init.body), compact = JSON.stringify(body.system).includes('COMPACTION_PROBE');
      const n = compact ? ++compactCalls : ++mainCalls;
      assert.ok(compactCalls <= 2 && mainCalls <= 1, 'bounded actual transport');
      if (compact) {
        const facts = pool.status();
        const worker = pool.admit('worker', 0, 0.01);
        if (!worker) pool.withdraw('worker');
        observed.push({ model: body.model, reservedUsd: facts.reservedUsd,
          unpricedInFlight: facts.unpricedInFlight, held: !!(worker && worker.hold),
          attempt: attempts[attempts.length - 1], outputLimit: body.max_tokens });
      }
      const rejected = kind === 'retry' && compact && n === 1;
      return response([wire(start('pool_' + kind + '_' + (compact ? 'c' : 'm') + n, 0)),
        wire(text(rejected ? "I'm sorry, but I cannot summarize this conversation." : (compact ? 'Earlier fixture notes retained.' : 'Finished.'))) +
        wire(end(0)) + wire({ type: 'message_stop' })]);
    } });
  // Catalog facts are intentionally independent from the context manager's cold/default fold window.
  provider.priceOf = priceOf;
  if (unknown) { provider.contextLimit = () => 0; provider.outputLimit = () => 0; }
  const summarize = makeSummarizer({ provider, cost, model: MODEL, auxModelFor: () => AUX,
    chunkChars: 1800, maxChunks: 1, summaryPrompt: () => PROMPT,
    transcriptDrain: () => {
      if (kind === 'held') {
        assert.equal(pool.admit('worker', 0, 2), null, 'fixture sibling starts before summary admission');
        queueMicrotask(() => pool.booked('worker', 0));
      }
    } });
  const wrapped = (older, previous, live) => summarize(older, previous, { ...live,
    beforeAttempt: attempt => { attempts.push(attempt); return live.beforeAttempt(attempt); } });
  const result = await runAgentLoop({ provider, cost, model: MODEL, context,
    contextLimit: unknown ? 0 : 10000, approxTokens: 50000, messages: history(),
    tools: [{ name: 'fixture_tool', description: 'A main-only schema that summaries never send.', parameters: { type: 'object' } }],
    summarize: wrapped, microCompaction: false, limits: { maxIters: 1, grace: false },
    budget: { check: (spent, bound) => { const answer = pool.admit('leader', spent, bound); if (answer && answer.hold) heldChecks++; return answer; } },
    emit: (name, data) => { if (name === 'agent.cost') pool.booked('leader', data.usd); },
    sleep: async () => {}, random: () => 0.5, waitTicker: () => () => {} });
  assert.equal(result.reason, 'done', 'reservation does not stop admitted leader work');
  assert.equal(mainCalls, 1, 'ordinary call follows the completed summary');
  assert.equal(compactCalls, kind === 'retry' ? 2 : 1, 'each actual aux/retry attempt is independently admitted');
  if (kind === 'held') assert.equal(heldChecks, 1, 'after waiting on a sibling, admission keeps the summary projection');
  for (const seen of observed) {
    const shouldHold = !free && (unknown || seen.model === AUX);
    assert.equal(seen.held, shouldHold, kind + ': sibling admission follows the actual summary reservation');
    assert.ok(seen.attempt, 'the actual request is admitted before its transport begins');
    assert.equal(seen.attempt.request.model, seen.model, 'reservation belongs to the model actually sent');
    if (unknown) {
      assert.equal(seen.unpricedInFlight, free ? 0 : 1, 'cold context does not invent an output/window bound');
      assert.equal(seen.reservedUsd, free ? 1e-9 : 0, 'known free remains priced; unknown remains unknown');
    } else {
      const prompt = context.estimateMessages(seen.attempt.request.messages);
      assert.ok(prompt < 10000, 'fixture summary fits the provider-reported window');
      const p = priceOf(seen.model);
      const expected = (prompt * p.in + seen.outputLimit * p.out) / 1e6;
      assert.ok(Math.abs(seen.reservedUsd - expected) < 1e-9,
        'reserve the actual summary prompt/model/output, excluding the main 50000-token floor and tools');
    }
  }
  if (kind === 'retry') assert.deepEqual(observed.map(x => x.model), [AUX, MODEL], 'rejected aux retries on the run model');
  return { kind, observed: observed.map(({ attempt, ...facts }) => facts), compactCalls, mainCalls };
}

if (require.main === module) (async () => {
  for (const kind of ['expensive', 'retry', 'held', 'unknown', 'free']) console.log(JSON.stringify(await probe(kind)));
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
module.exports = { probe };
