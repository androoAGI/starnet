/* node test/micro.durability.test.js — the FREE micro-compaction tier must not delete tool output from the
   durable transcript.

   The bug (audit 09-22, Hermes parity): maybeCompact's micro tier replaced older tool-result bodies with a 240-char
   head in NEW message objects and never saved the originals first. The copies lacked transcriptstore's PERSISTED
   marker, so the run-end save (index.js: appendNewStrict over result.messages) wrote the ELIDED heads as the
   durable record, and the run journal holding the real bodies was retired right after. Probe: 40 tool turns with
   micro on (the default) -> only 11/40 full tool outputs survived on disk / in recall_conversation.

   Drives the REAL runAgentLoop + real makeContext (micro fires on its own) + the REAL makeSummarizer wired exactly
   like runOnce (transcriptDrain = store.appendNewStrict) + the REAL transcriptstore over an in-memory durable io,
   then performs the run-end save exactly like runOnce. Invariant: every full tool body is stored EXACTLY ONCE and
   no "[tool result elided at compaction" copy is stored; a failing drain refuses the elision; a transient failure
   heals without duplicates; an already-persisted (resumed) tool turn is not re-appended as its elided copy; and the
   model-facing prompt still carries the elided heads (that part of the tier is correct and kept). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeSummarizer } = require('../sidecar/compaction-summarizer.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const failopen = require('../sidecar/failopen.js');

const STREAM = 'micro-s', AGENT = 'a', N = 7;
const ELIDED_RE = /^\[tool result elided at compaction/;
const openCtx = () => ({ agentId: AGENT, canUse: () => ({ ok: true }), canRun: () => ({ ok: true }) });
const toolTurn = (id, p) => [{ type: 'tool_start', index: 0, id, name: 'noop' }, { type: 'tool_args', index: 0, chunk: '{}' },
  { type: 'usage', usage: { prompt_tokens: p, completion_tokens: 1, total_tokens: p + 1 } }, { type: 'done', finishReason: 'tool_calls' }];
const stopTurn = [{ type: 'text', delta: 'FINAL ANSWER' }, { type: 'done', finishReason: 'stop' }];
// the full body of call k: a head the elision keeps, and an END marker far past the 240-char head it drops
const bodyOf = (k) => 'BODY#' + k + ' ' + 'x'.repeat(8000) + ' END#' + k;

// an in-memory durable io with the host's shape; failAt(n) decides whether the n-th DURABLE write throws
function memIo(failAt) {
  const lines = []; let durable = 0;
  return {
    lines,
    io: {
      readAll: () => lines.slice(),
      append: (e) => { lines.push(e); },
      appendDurable: (e) => { durable++; if (failAt && failAt(durable)) throw new Error('injected fsync failure #' + durable); lines.push(e); }
    }
  };
}

async function run(opts) {
  opts = opts || {};
  const mem = memIo(opts.failAt);
  const store = makeTranscriptStore({ io: mem.io, clock: { now: () => 1000 } });
  const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); const emit = makeEmitter(bus, () => {});
  let k = 0;
  const R = makeRegistry(); R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => bodyOf(++k) });
  const turns = []; for (let i = 1; i <= N; i++) turns.push(toolTurn('c' + i, 14000)); turns.push(stopTurn);
  const provider = makeReplayProvider({ turns });
  let paidCalls = 0;
  // wired like index.js runOnce: the STRICT durable drain is the summarizer's transcriptDrain (summarize.drain)
  const summarize = makeSummarizer({
    streamFn: async function* () { paidCalls++; yield { type: 'text', delta: '## Completed\n- paid fold' }; yield { type: 'done', finishReason: 'stop' }; },
    cost: makeCostEngine({ priceOf: () => null }), model: 'm', summaryPrompt: () => 'P',
    transcriptDrain: (older) => store.appendNewStrict(STREAM, AGENT, older, { sourceRunId: 'run-1' })
  });
  const messages = [{ role: 'system', content: 'sys' }].concat(opts.seed || [], [{ role: 'user', content: 'THE DIRECTIVE: read every file' }]);
  store.markPersisted(messages);   // exactly what runOnce does before handing the prompt to the loop
  const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: AGENT, runId: 'run-1', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(),
    context: makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 }), summarize, limits: { maxIters: 20 } });
  // the run-end save, exactly like runOnce's journal path (a throw there is caught by runOnce; mirror that)
  let endThrew = null;
  try { store.appendNewStrict(STREAM, AGENT, res.messages, { sourceRunId: 'run-1' }); } catch (e) { endThrew = e; }
  return { res, seq, mem, store, paidCalls: () => paidCalls, endThrew };
}
const toolRows = (lines) => lines.filter(r => r.streamId === STREAM && r.role === 'tool');

(async () => {
  // ---- 1. micro fires; every full tool body is stored exactly once; no elided copy is stored ----
  {
    const r = await run();
    A.eq(r.res.reason, 'done', '(1) the run completes');
    const micro = r.seq.filter(e => e.name === 'agent.compact' && e.payload.reason === 'micro');
    A.ok(micro.length >= 2, '(1) the free micro tier really fired (' + micro.length + 'x) — the invariant below is not vacuous');
    A.eq(r.paidCalls(), 0, '(1) no paid fold was needed (micro cleared the threshold every time)');
    const liveElided = r.res.messages.filter(m => m.role === 'tool' && ELIDED_RE.test(String(m.content)));
    A.ok(liveElided.length >= 1, '(1) the model-facing prompt keeps the elided heads (' + liveElided.length + ')');
    A.ok(liveElided.every(m => /\nBODY#\d+ x+…$/.test(m.content)), '(1) each elided copy keeps the 240-char head of its body');

    const rows = toolRows(r.mem.lines);
    A.eq(rows.length, N, '(1) exactly ' + N + ' tool rows stored — one per call, none duplicated');
    for (let k = 1; k <= N; k++) {
      const mine = rows.filter(x => x.toolCallId === 'c' + k);
      A.eq(mine.length, 1, '(1) call c' + k + ' stored exactly once');
      A.ok(mine[0] && mine[0].content === bodyOf(k), '(1) call c' + k + ' stored with its FULL body (END#' + k + ' present)');
    }
    A.eq(r.mem.lines.filter(x => ELIDED_RE.test(String(x.content))).length, 0, '(1) NO elided copy reached the durable transcript');
    const asst = r.mem.lines.filter(x => x.role === 'assistant' && x.toolCalls);
    A.eq(asst.length, N, '(1) every assistant tool_call turn stored exactly once');
    A.ok(r.mem.lines.some(x => x.role === 'assistant' && x.content === 'FINAL ANSWER'), '(1) the final answer is stored');
    const order = rows.map(x => x.toolCallId).join(',');
    A.eq(order, Array.from({ length: N }, (_, i) => 'c' + (i + 1)).join(','), '(1) tool rows are stored in chronological order');
    A.ok(!r.mem.lines.some(x => /THE DIRECTIVE/.test(x.content)), '(1) the already-persisted directive was not re-appended by the loop drains');

    // restart round-trip: a fresh store over the same durable lines recalls every full body
    const reborn = makeTranscriptStore({ io: { readAll: () => r.mem.lines.slice(), append() {} }, clock: { now: () => 0 } });
    const hist = reborn.history(STREAM, { limit: 500 });
    let full = 0; for (let k = 1; k <= N; k++) if (hist.some(x => x.content === bodyOf(k))) full++;
    A.eq(full, N, '(1) after a restart all ' + N + '/' + N + ' full tool outputs are recallable (the audit saw 11/40)');
    const hit = reborn.search(STREAM, 'END#3', { limit: 5 });
    A.ok(hit.some(x => x.role === 'tool' && x.content === bodyOf(3)), '(1) recall search finds text that lived only past the elided head');
  }

  // ---- 2. a FAILING drain refuses the elision: no micro commit, full bodies stay in the prompt ----
  {
    const before = failopen.counts()['loop.compaction.microDrain'] || 0;
    const r = await run({ failAt: () => true });
    A.eq(r.res.reason, 'done', '(2) a transcript fsync failure does not crash the run');
    A.eq(r.seq.filter(e => e.name === 'agent.compact').length, 0, '(2) no compaction is committed while the durable drain fails');
    A.eq(r.res.messages.filter(m => m.role === 'tool' && ELIDED_RE.test(String(m.content))).length, 0, '(2) nothing was elided from the prompt');
    let full = 0; for (let k = 1; k <= N; k++) if (r.res.messages.some(m => m.role === 'tool' && m.content === bodyOf(k))) full++;
    A.eq(full, N, '(2) every full body is still in the live prompt (nothing lost)');
    A.ok((failopen.counts()['loop.compaction.microDrain'] || 0) > before, '(2) the refused drain is reported through failNote (loop.compaction.microDrain)');
    A.ok(r.endThrew, '(2) the run-end strict save also fails loudly (runOnce keeps the journal for recovery)');
  }

  // ---- 3. a TRANSIENT failure mid-drain heals: partial rows are not duplicated, nothing is lost ----
  {
    const before = failopen.counts()['loop.compaction.microDrain'] || 0;
    const r = await run({ failAt: (n) => n === 2 });   // the 2nd durable write of the run throws once
    A.eq(r.res.reason, 'done', '(3) the run completes');
    A.eq((failopen.counts()['loop.compaction.microDrain'] || 0) - before, 1, '(3) exactly one micro drain was refused (the injected failure hit the micro tier)');
    A.ok(r.seq.some(e => e.name === 'agent.compact' && e.payload.reason === 'micro'), '(3) a later micro fold committed once the drain succeeded');
    const rows = toolRows(r.mem.lines);
    for (let k = 1; k <= N; k++) {
      const mine = rows.filter(x => x.toolCallId === 'c' + k);
      A.ok(mine.length === 1 && mine[0].content === bodyOf(k), '(3) call c' + k + ' stored exactly once with its full body');
    }
    A.eq(r.mem.lines.filter(x => ELIDED_RE.test(String(x.content))).length, 0, '(3) no elided copy stored');
    A.eq(r.mem.lines.filter(x => x.role === 'assistant' && x.toolCalls).length, N, '(3) no assistant turn duplicated by the retry');
  }

  // ---- 4. a RESUMED tool turn (already persisted before the run) is never re-appended as its elided copy ----
  {
    const seed = [
      { role: 'user', content: 'prior ask' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'p1', content: 'SEED-BODY ' + 'y'.repeat(8000) + ' SEED-END' },
      { role: 'assistant', content: 'prior answer' }
    ];
    const r = await run({ seed });
    const liveSeed = r.res.messages.find(m => m.role === 'tool' && m.tool_call_id === 'p1');
    A.ok(liveSeed && ELIDED_RE.test(liveSeed.content), '(4) the resumed tool result WAS elided in the live prompt (the case is exercised)');
    A.eq(r.mem.lines.filter(x => x.toolCallId === 'p1').length, 0, '(4) its elided copy was NOT appended as new dialogue (marker carried onto the copy)');
    A.eq(r.mem.lines.filter(x => ELIDED_RE.test(String(x.content))).length, 0, '(4) no elided copy stored at all');
    A.eq(toolRows(r.mem.lines).length, N, '(4) this run\'s own ' + N + ' tool bodies are still stored once each');
  }

  // ---- 5. no drain wired (a bare injected summarizer): the micro tier behaves exactly as before ----
  {
    const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); const emit = makeEmitter(bus, () => {});
    const R = makeRegistry(); let k = 0; R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => bodyOf(++k) });
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 14000), toolTurn('c2', 14000), toolTurn('c3', 14000), stopTurn] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: AGENT, runId: 'r5', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(),
      context: makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 }), summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }) });
    A.eq(res.reason, 'done', '(5) the run completes');
    A.ok(seq.some(e => e.name === 'agent.compact' && e.payload.reason === 'micro'), '(5) micro still fires with no drain configured');
  }

  A.report('micro.durability.test');
})().catch(e => { console.error(e); process.exit(1); });
