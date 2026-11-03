/* Provider receipts survive adapter -> loop/aux -> immutable ledger without inventing usage.
   Fakes replace only the transport. IDs count identified call attempts; at most 32 exact IDs are retained. */
'use strict';
const A = require('./_assert.js');
const { makeLedger, makeAuxMeter, auxLoopFloors } = require('../sidecar/ledger.js');
const protocol = require('../sidecar/providers/provider.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeSummarizer } = require('../sidecar/compaction-summarizer.js');
const cost = makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) });
const usage = id => ({ prompt_tokens: 10, completion_tokens: 2, cost: 0.01, ...(id ? { generation_id: id } : {}) });
const sse = rows => rows.map(row => 'data: ' + JSON.stringify(row)).join('\n') + '\n';
const fetchOf = rows => async () => new Response(sse(rows), { headers: { 'Content-Type': 'text/event-stream' } });
const req = { model: 'fixture/m', messages: [{ role: 'user', content: 'go' }] };
const chatRows = id => [
  { ...(id == null ? {} : { id }), choices: [{ delta: { content: 'hello' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: usage() }
];
const adapters = [
  ['openrouter', makeOpenRouterProvider, chatRows, { key: 'fixture' }],
  ['openai-compatible', makeOpenAICompatibleProvider, chatRows, { key: 'fixture', baseUrl: 'http://fixture.invalid/v1' }],
  ['anthropic', makeAnthropicProvider, id => [
    { type: 'message_start', message: { ...(id == null ? {} : { id }), usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }
  ], { key: 'fixture' }],
  ['codex', makeCodexProvider, id => [
    { type: 'response.created', response: { ...(id == null ? {} : { id }) } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } }
  ], { token: 'fixture' }]
];
async function collect(p) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
function ledger() {
  const rows = []; return { rows, L: makeLedger({ io: { readAll: () => rows.slice(), append: e => rows.push(e) }, clock: { now: () => 100 } }) };
}
async function loop(stream, opts) {
  const reg = makeRegistry(); reg.register({ name: 'note_x', impact: 'none', schema: { type: 'object', properties: {} }, run: async () => 'noted' });
  return runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: { stream, contextLimit: () => 0 },
    model: 'fixture/m', agentId: 'a', runId: 'r', cost, emit() {},
    tools: [{ type: 'function', function: { name: 'note_x', parameters: { type: 'object', properties: {} } } }],
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }) },
    limits: { maxIters: 40, grace: false }, clock: { now: () => 100 }, waitTicker: () => () => {}, ...opts });
}
(async () => {
  for (const [name, make, rows, auth] of adapters) {
    for (const id of ['gen-' + name, undefined, '', 42, 'bad\nid', 'x'.repeat(257)]) {
      const events = await collect(make({ ...auth, fetch: fetchOf(rows(id)) }));
      const valid = typeof id === 'string' && id.startsWith('gen-');
      const us = events.filter(e => e.type === 'usage');
      A.ok(us.length > 0, name + ': actual usage is still emitted');
      A.eq(us.map(e => e.usage.generation_id), us.map(() => valid ? id : undefined), name + ': only exact valid upstream ID is carried across split usage');
      A.eq(events.filter(e => e.type === 'generation').map(e => e.id), valid ? [id] : [], name + ': optional metadata emits once');
      A.eq(events.filter(e => e.type === 'done').length, 1, name + ': one terminal event unchanged');
    }
  }
  // An ID before usage is metadata only. A final chunk without newline still retains the ID.
  for (const [name, make, rows, auth] of adapters) {
    const id = 'early-' + name;
    const initial = rows(id)[0];
    if (initial.message) delete initial.message.usage;
    const events = await collect(make({ ...auth, fetch: async () => new Response(sse([initial]).trimEnd()) }));
    A.eq(events.filter(e => e.type === 'generation').map(e => e.id), [id], name + ': early ID survives final-line flush');
    A.eq(events.filter(e => e.type === 'usage').length, 0, name + ': receipt metadata never fabricates usage');
  }
  {
    const { L, rows } = ledger(); const ids = Array.from({ length: 40 }, (_, i) => 'gen-' + i);
    const row = L.record({ runId: 'r', usd: 1, generationIds: ids, generationCount: 40 });
    A.eq(row.generationIds, ids.slice(0, 32), 'ledger stores first 32 exact IDs');
    A.eq(row.generationCount, 40, 'ledger keeps full identified-call count');
    ids[0] = 'mutated'; A.eq(rows[0].generationIds && rows[0].generationIds[0], 'gen-0', 'ledger copies caller array');
    const restart = makeLedger({ io: { readAll: () => rows.slice() }, clock: { now: () => 101 } });
    A.eq(restart.all()[0].generationIds, row.generationIds, 'restart keeps receipts');
    A.eq(restart.totalUsd(), 1, 'receipts do not change money folds');
    const legacy = L.record({ runId: 'old', usd: 0 });
    A.ok(!('generationIds' in legacy) && !('generationCount' in legacy), 'no fabricated receipt on legacy/no-ID row');
    const bad = L.record({ runId: 'bad', generationIds: ['', null, 'ok', 'x'.repeat(257)], generationCount: -2 });
    A.eq([bad.generationIds, bad.generationCount], [['ok'], 1], 'invalid handles/count rejected without truncating opaque IDs');
  }
  {
    let calls = 0;
    const result = await loop(async function* () {
      const n = calls++, id = 'turn-' + n;
      yield { type: 'generation', id };
      yield { type: 'usage', usage: usage(id) };
      yield { type: 'usage', usage: usage(id) }; // cumulative/duplicate receipt is still one attempt
      if (n < 34) { yield { type: 'tool_start', index: 0, id: 'tc-' + n, name: 'note_x' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; }
      else yield { type: 'text', delta: 'finished' };
      yield { type: 'done', finishReason: n < 34 ? 'tool_calls' : 'stop' };
    });
    A.eq(result.reason, 'done', '35 actual tool-loop calls finish');
    A.eq(calls, 35, 'loop made each real request');
    A.eq(result.generationIds, Array.from({ length: 32 }, (_, i) => 'turn-' + i), 'loop bounded first 32 IDs');
    A.eq(result.generationCount, 35, 'split usage counts once per stream');
    A.ok(Math.abs(result.usd - 0.35) < 1e-9, 'receipt capture leaves booked usage unchanged');
    const row = ledger().L.record({ runId: 'main', ...result });
    A.eq(row.generationCount, 35, 'loop receipt persists in main ledger shape');
    const floors = auxLoopFloors(result, true);
    A.eq(floors.generationCount, 35, 'nested subscription loop carries IDs even when unmetered');
  }
  {
    const ac = new AbortController();
    const result = await loop(async function* () {
      yield { type: 'generation', id: 'cancelled-call' };
      yield { type: 'text', delta: 'partial' };
      ac.abort();
    }, { signal: ac.signal });
    A.eq(result.reason, 'cancelled', 'cancel remains cancelled');
    A.eq(result.generationIds, ['cancelled-call'], 'cancel keeps the known provider handle');
    A.eq(result.streamCut, true, 'metadata does not erase missing-usage floor');
    A.eq(result.usd, 0, 'metadata does not invent a charge');
  }
  {
    const { L, rows } = ledger(); const m = makeAuxMeter({ ledger: L, kind: 'reflection' });
    await m.stream({ async *stream() { yield { type: 'generation', id: 'aux-1' }; yield { type: 'usage', usage: usage('aux-1') }; yield { type: 'usage', usage: usage('aux-1') }; } }, req, cost);
    try { await m.stream({ async *stream() { yield { type: 'generation', id: 'aux-cut' }; throw new Error('cut'); } }, req, cost); } catch (_) {}
    const row = m.book({ runId: 'aux', agentId: 'a', model: req.model });
    A.eq(row.generationIds, ['aux-1', 'aux-cut'], 'aux retains successful and failed-stream handles');
    A.eq(row.generationCount, 2, 'aux counts each attempt once');
    A.eq(row.usageMissing, true, 'ID-only aux call remains usage missing');
    A.eq(row.usd, 0.01, 'known aux dollars unchanged');
    A.eq(m.book({ runId: 'again' }), null, 'second book cannot duplicate receipts');
    m.add(usage('aux-next'), cost, req.model);
    const next = m.book({ runId: 'next' });
    A.eq(next.generationIds, ['aux-next'], 'new aux batch starts clean');
    A.eq(rows.length, 2, 'one row per booked batch');
  }
  {
    const generationReceipt = protocol.makeGenerationReceipt ? protocol.makeGenerationReceipt() : { begin: () => () => {}, fields: () => ({}) };
    const summarizer = makeSummarizer({ model: 'fixture/m', cost, provider: { async *stream() {
      yield { type: 'generation', id: 'summary-call' }; yield { type: 'usage', usage: usage('summary-call') };
      yield { type: 'text', delta: 'The work is summarized.' }; yield { type: 'done', finishReason: 'stop' };
    } } });
    const result = await summarizer([{ role: 'user', content: 'earlier work' }], '', { generationReceipt });
    A.eq(result.usd, 0.01, 'summarizer accounting unchanged');
    A.eq(generationReceipt.fields().generationIds, ['summary-call'], 'compaction charge joins the parent receipt');
  }
  A.report('ledger.generation-id.test');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
