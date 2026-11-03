'use strict';
/* Production loop, summarizer/adapters and accounting. Only transport bytes are faked.
 * The paired old-source control is retained in the lane evidence report. No live billing claim. */
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const from = rel => require(path.join(root, rel));
const { runAgentLoop } = from('sidecar/loop.js');
const { makeContext } = from('sidecar/context.js');
const { makeSummarizer } = from('sidecar/compaction-summarizer.js');
const { makeCostEngine } = from('sidecar/cost.js');
const { makeAnthropicProvider } = from('sidecar/providers/anthropic.js');
const MODEL = 'fixture-compaction-model';
const PROMPT = 'COMPACTION_PROBE: faithfully summarize earlier assistant notes.';
const encoder = new TextEncoder();
const wire = event => 'data: ' + JSON.stringify(event) + '\n\n';
const start = (id, input) => ({ type: 'message_start', message: {
  id, type: 'message', role: 'assistant', model: MODEL,
  usage: { input_tokens: input, output_tokens: 0 }
} });
const text = s => ({ type: 'content_block_delta', index: 0,
  delta: { type: 'text_delta', text: s } });
const end = output => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: output } });
const streamError = { type: 'error', error: { type: 'api_error', message: 'fixture stream failed after usage' } };
function abortError() { const e = new Error('fixture abort after observed usage'); e.name = 'AbortError'; return e; }

/* A demand-driven byte reader prevents ReadableStream prefetch from moving the cancel
 * before the decoder has yielded the previous usage. There are no timers or sleeps.
 * The real provider's idle/abort wrapper still encloses this reader.
 */
function response(steps) {
  let at = 0;
  const reader = {
    async read() {
      if (at >= steps.length) return { done: true, value: undefined };
      const step = steps[at++];
      const s = typeof step === 'function' ? step() : step;
      return s == null ? { done: true, value: undefined } : { done: false, value: encoder.encode(s) };
    },
    async cancel() {}, releaseLock() {}
  };
  const out = new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  Object.defineProperty(out, 'body', { value: { getReader: () => reader } });
  return out;
}
function history() {
  const rows = [{ role: 'system', content: 'Use the recorded notes and answer briefly.' },
    { role: 'user', content: 'Review the fixture notes.' }];
  for (let n = 0; n < 5; n++) {
    rows.push({ role: 'assistant', content: ('Earlier note ' + n + ': stable detail. ').repeat(160) });
    rows.push({ role: 'user', content: 'Continue note ' + n + '.' });
  }
  rows.push({ role: 'assistant', content: 'All notes are recorded.' }, { role: 'user', content: 'Finish.' });
  return rows;
}

async function scenario(kind) {
  const ac = new AbortController(), observed = new Map(), calls = [], costs = [];
  let compactCalls = 0, mainCalls = 0;
  const cost = makeCostEngine({ priceOf: () => ({ in: 1000, out: 1000 }) });
  const fixtureFetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://compaction-probe.invalid/'), 'all transport stays in fixture');
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    assert.ok(String(url).endsWith('/messages'), 'unexpected adapter URL');
    const body = JSON.parse(init.body);
    const compact = JSON.stringify(body.system).includes('COMPACTION_PROBE');
    const n = compact ? ++compactCalls : ++mainCalls;
    assert.ok(compactCalls <= 12 && mainCalls <= 2, 'fixture must not enter an unbounded request loop');
    const id = 'probe_' + kind + '_' + (compact ? 'compact_' : 'main_') + n;
    calls.push({ id, compact, n });
    const input = compact ? 100 : 0, output = compact ? 10 : 0;
    const initial = () => {
      observed.set(id, { prompt_tokens: input, completion_tokens: 0 });
      return wire(start(id, input));
    };
    const complete = () => {
      observed.set(id, { prompt_tokens: input, completion_tokens: output });
      return wire(text(compact ? 'The earlier notes remain available in the transcript.' : 'Finished.')) +
        wire(end(output)) + wire({ type: 'message_stop' });
    };
    const failThis = compact && ((kind === 'usage_then_throw' && n === 1) ||
      (kind === 'first_chunk_then_throw' && n === 2));
    if (failThis) return response([initial, wire(streamError)]);
    if (compact && n === 1 && kind === 'cancel_during_usage') {
      return response([initial, () => { ac.abort(); throw abortError(); }]);
    }
    if (compact && n === 1 && kind === 'cancel_after_usage') {
      return response([initial, complete, () => { ac.abort(); return null; }]);
    }
    return response([initial, complete]);
  };
  const provider = makeAnthropicProvider({ key: 'fixture-key', baseUrl: 'https://compaction-probe.invalid',
    fetch: fixtureFetch, defaultContext: 1000, reasoningEffort: 'none' });
  const summarize = makeSummarizer({ provider, cost, model: MODEL, signal: ac.signal,
    agentId: 'compaction-probe', runId: 'compaction-' + kind, chunkChars: 1800, maxChunks: 8,
    summaryPrompt: () => PROMPT, emit: (name, data) => { if (name === 'agent.cost') costs.push(data); } });
  const result = await runAgentLoop({ provider, cost, model: MODEL, signal: ac.signal,
    agentId: 'compaction-probe', runId: 'compaction-' + kind, messages: history(),
    context: makeContext({ contextLimit: 1000, compactAt: 0.5, keepTailTurns: 1 }),
    summarize, microCompaction: false, limits: { maxIters: 1, grace: false },
    emit: () => {}, sleep: async () => {}, random: () => 0.5,
    waitTicker: () => () => {} });
  assert.ok(compactCalls >= (kind === 'first_chunk_then_throw' ? 2 : 1), kind + ': reached intended real fold');
  const expected = [...observed.values()].map(usage => cost.reconcile(usage, MODEL));
  const floor = expected.reduce((n, c) => n + (c.usd || 0), 0);
  const tokens = expected.reduce((n, c) => n + (c.tokensIn || 0) + (c.tokensOut || 0), 0);
  assert.ok(floor > 0, kind + ': a positive usage floor was actually observed');
  // Equality proves the fix also avoids double-booking the successful prefix/retry.
  assert.ok(Math.abs(result.usd - floor) < 1e-9,
    kind + ': loop retains observed compaction USD exactly: got ' + result.usd + ', expected ' + floor);
  assert.equal(result.tokens, tokens, kind + ': loop retains observed compaction tokens exactly');
  const missing = kind !== 'cancel_after_usage';
  assert.equal(result.usageMissing === true, missing, kind + ': cut compaction remains a known floor, not complete usage');
  const { makeLedger, auxLoopFloors } = from('sidecar/ledger.js');
  const { readSidecarSource } = require('./helpers/source.js');
  const source = readSidecarSource();
  const assignment = source.match(/const usageMissing = !rowUnmetered[^\n]+;/);
  assert.ok(assignment, 'real host missing-usage projection found');
  const project = new Function('result', 'rowUnmetered', assignment[0] + ' return usageMissing;');
  const row = makeLedger({ clock: { now: () => 1 } }).record({ runId: 'floor', usd: result.usd, tokens: result.tokens, ...result, usageMissing: project(result, false) });
  assert.equal(row.usageMissing === true, missing, kind + ': durable main row preserves missing-usage fact');
  assert.equal(auxLoopFloors(result, false).usageMissing === true, missing, kind + ': nested aux floor also preserves fact');
  assert.equal(auxLoopFloors(result, true).usageMissing, undefined, 'unmetered row acquires no dollar uncertainty');
  const ids = result.generationIds || [];
  for (const call of calls.filter(c => c.compact)) assert.ok(ids.includes(call.id), kind + ': receipt retains ' + call.id);
  if (kind.startsWith('cancel_')) {
    assert.equal(mainCalls, 0, kind + ': cancellation prevents the ordinary generation');
    assert.equal(result.reason, 'cancelled', kind + ': cancellation remains the terminal reason');
  }
  return { kind, compactCalls, mainCalls, floor, tokens, reason: result.reason, costEvents: costs.length };
}

module.exports = { from, MODEL, PROMPT, wire, start, text, end, response, history, scenario };
if (require.main === module) (async () => {
  for (const kind of ['usage_then_throw', 'first_chunk_then_throw', 'cancel_during_usage', 'cancel_after_usage']) {
    console.log(JSON.stringify(await scenario(kind)));
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
