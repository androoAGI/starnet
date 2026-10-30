/* node test/summarizer.guards.test.js — a CUT-OFF or REFUSED compaction summary is a FAILED summary.

   Audit probe (09-22, Hermes parity): a run's history was folded into "Audit config files. VALUE_01=" (the
   summarizer hit its output cap, finishReason 'length') and into "I'm sorry, but I can't provide the requested
   summary." (a refusal). Both were committed as the <conversation_summary>, so the raw turns were deleted and the
   run worked from a fragment. compaction-summarizer.js only read text + usage and never looked at WHY the stream
   stopped; the loop only rejected an EMPTY summary.

   Proves, with the REAL makeSummarizer driven through the REAL runAgentLoop (no network):
     (1) finishReason 'length' -> summary '' + rejected, spend still reported; the loop emits NO agent.compact,
         the history is unchanged, and the summarizer's spend joins the run total;
     (2) a refusal body -> same;
     (3) two rejections trip the existing compactionFails breaker -> the deterministic fallback note takes over;
     (4) content_filter / truncated:true are rejected; 'stop', no done event, and an unrecognized 'error'
         finish are NOT (a working provider never loses its folds to a guess);
     (5) chunked folds: a cut in ANY chunk rejects the whole fold and no later chunk is merged onto it;
     (6) the aux-tier floor gives a cut aux summary exactly one retry on the run model;
     (7) the refusal heuristic is conservative (structured / long / merely-apologetic summaries pass);
     (8) a normal summary still folds (reason 'context'). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeSummarizer, partition, looksLikeRefusal, rejectReason } = require('../sidecar/compaction-summarizer.js');

const cost = makeCostEngine({ priceOf: () => ({ prompt: '0.000001', completion: '0.000002' }) });
const SUM_USD = 0.5;   // provider-billed $ per summarizer call — large so it is unmistakable in the run total

// a scripted summarizer stream: body(n, req) -> { text, done } where done is the adapter's done event (or null)
function scriptedStream(body) {
  const reqs = [];
  const streamFn = async function* (req) {
    reqs.push(req);
    const b = body(reqs.length, req);
    if (b.text) yield { type: 'text', delta: b.text };
    yield { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: SUM_USD } };
    if (b.done) yield Object.assign({ type: 'done' }, b.done);
  };
  return { reqs, streamFn };
}
const GOOD = '## Goal\nread the files\n## Completed\n- VALUE_01=alpha\n- VALUE_02=beta';
const CUT = 'Audit config files. VALUE_01=';
const REFUSAL = "I'm sorry, but I can't provide the requested summary.";

function setup() { const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); return { seq, emit: makeEmitter(bus, () => {}) }; }
const openCtx = () => ({ agentId: 'a', canUse: () => ({ ok: true }), canRun: () => ({ ok: true }) });
const toolTurn = (id, p) => [{ type: 'tool_start', index: 0, id, name: 'noop' }, { type: 'tool_args', index: 0, chunk: '{}' },
  { type: 'usage', usage: { prompt_tokens: p, completion_tokens: 1, total_tokens: p + 1 } }, { type: 'done', finishReason: 'tool_calls' }];
const stopTurn = [{ type: 'text', delta: 'final' }, { type: 'done', finishReason: 'stop' }];
function reg() { const r = makeRegistry(); r.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => 'tool output ' + 'q'.repeat(200) }); return r; }
// an injected context that always wants to fold; no thresholdTokens => the free micro tier stays out of the way
const alwaysFold = () => ({
  shouldCompact: () => true,
  estimateMessages: (arr) => arr.reduce((t, m) => t + Math.ceil(String(m.content || '').length / 4) + 4, 0),
  planCompaction: (arr) => ({ older: arr.slice(0, Math.max(0, arr.length - 1)), tail: arr.slice(Math.max(0, arr.length - 1)) })
});
function seedMessages() {
  return [{ role: 'user', content: 'THE DIRECTIVE' },
    { role: 'user', content: 'old-1 VALUE_01=alpha ' + 'z'.repeat(2000) },
    { role: 'assistant', content: 'old-2 VALUE_02=beta ' + 'z'.repeat(2000) },
    { role: 'user', content: 'old-3' }];
}
const noteOf = (msgs) => msgs.find(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));

async function runWith(body, turns) {
  const { seq, emit } = setup();
  const s = scriptedStream(body);
  let drained = 0;
  const summarize = makeSummarizer({ streamFn: s.streamFn, cost, model: 'm', summaryPrompt: () => 'P', transcriptDrain: (older) => { drained += older.length; } });
  const provider = makeReplayProvider({ turns });
  const R = reg();
  const messages = seedMessages();
  const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(),
    context: alwaysFold(), summarize });
  return { res, seq, reqs: s.reqs, messages, drained: () => drained };
}

(async () => {
  // ---- (1) finishReason 'length' through the real loop: one attempt, history untouched, spend counted ----
  {
    // one model turn: the only fold attempt is the preflight before it (alwaysFold would re-attempt on every later turn)
    const r = await runWith(() => ({ text: CUT, done: { finishReason: 'length' } }), [stopTurn]);
    A.eq(r.res.reason, 'done', '(1) the run still completes');
    A.eq(r.reqs.length, 1, '(1) exactly one summarizer call was made');
    A.eq(r.seq.filter(e => e.name === 'agent.compact').length, 0, '(1) a length-cut summary emits NO agent.compact');
    A.ok(!noteOf(r.messages), '(1) no <conversation_summary> note was committed');
    A.ok(!r.messages.some(m => String(m.content || '').indexOf(CUT) >= 0), '(1) the fragment "' + CUT + '" never entered the prompt');
    A.ok(r.messages.some(m => /^old-1 VALUE_01=alpha/.test(String(m.content || ''))) && r.messages.some(m => /^old-2 VALUE_02=beta/.test(String(m.content || ''))),
      '(1) the original older turns are still in the working set (history NOT replaced)');
    A.ok(r.res.usd >= SUM_USD - 1e-9, '(1) the rejected summarizer call is billed into the run total (' + r.res.usd + ')');
  }

  // ---- (2) refusal body (finishReason 'stop'): identical treatment ----
  {
    const r = await runWith(() => ({ text: REFUSAL, done: { finishReason: 'stop' } }), [toolTurn('c1', 100), stopTurn]);
    A.eq(r.res.reason, 'done', '(2) the run still completes');
    A.eq(r.seq.filter(e => e.name === 'agent.compact').length, 0, '(2) a refusal emits NO agent.compact');
    A.ok(!noteOf(r.messages), '(2) no summary note was committed');
    A.ok(!r.messages.some(m => String(m.content || '').indexOf("I'm sorry") >= 0), '(2) the refusal text never entered the prompt');
    A.ok(r.messages.some(m => /^old-1 VALUE_01=alpha/.test(String(m.content || ''))), '(2) the original older turns survive');
    A.ok(r.res.usd >= SUM_USD - 1e-9, '(2) the refused call is billed into the run total');
  }

  // ---- (3) failures COUNT: two rejections trip the breaker; the deterministic fallback note takes over ----
  {
    const r = await runWith(() => ({ text: CUT, done: { finishReason: 'length' } }),
      [toolTurn('c1', 100), toolTurn('c2', 100), toolTurn('c3', 100), toolTurn('c4', 100), stopTurn]);
    A.eq(r.res.reason, 'done', '(3) the run completes');
    A.eq(r.reqs.length, 2, '(3) the summarizer was tried exactly twice (breaker at 2 counts cut summaries)');
    const ev = r.seq.filter(e => e.name === 'agent.compact');
    A.ok(ev.length >= 1 && ev.every(e => e.payload.reason === 'fallback'), '(3) every commit after the breaker is the deterministic fallback (' + ev.map(e => e.payload.reason).join(',') + ')');
    const note = noteOf(r.messages);
    A.ok(note && /compaction fallback/.test(note.content), '(3) the fallback note replaced the history');
    A.ok(note && note.content.indexOf(CUT) < 0, '(3) the cut fragment is nowhere in the committed note');
    A.ok(note && /old-1 VALUE_01=alpha/.test(note.content), '(3) the fallback note digests the REAL older turns');
    A.ok(r.drained() > 0, '(3) the durable drain ran before the fallback fold');
    A.ok(r.res.usd >= 2 * SUM_USD - 1e-9, '(3) both rejected calls are billed (' + r.res.usd + ')');
  }

  // ---- (4) which finish signals reject, directly on the summarizer ----
  {
    const older = seedMessages().slice(1);
    const run = async (body) => makeSummarizer({ streamFn: scriptedStream(body).streamFn, cost, model: 'm', summaryPrompt: () => 'P' })(older, '', null);
    let o = await run(() => ({ text: CUT, done: { finishReason: 'length' } }));
    A.eq(o.summary, '', '(4) length -> empty summary'); A.eq(o.rejected, 'length', '(4) length -> rejected:length');
    A.ok(Math.abs(o.usd - SUM_USD) < 1e-9 && o.tokens === 110, '(4) a rejected fold still reports its spend');
    o = await run(() => ({ text: GOOD, done: { finishReason: 'content_filter' } }));
    A.eq(o.summary, '', '(4) content_filter -> empty summary'); A.eq(o.rejected, 'content_filter', '(4) content_filter -> rejected');
    o = await run(() => ({ text: GOOD, done: { finishReason: null, truncated: true } }));
    A.eq(o.summary, '', '(4) a transport-truncated stream -> empty summary'); A.eq(o.rejected, 'truncated', '(4) truncated -> rejected');
    o = await run(() => ({ text: REFUSAL, done: { finishReason: 'stop' } }));
    A.eq(o.summary, '', '(4) refusal -> empty summary'); A.eq(o.rejected, 'refusal', '(4) refusal -> rejected:refusal');
    o = await run(() => ({ text: GOOD, done: { finishReason: 'stop' } }));
    A.eq(o.summary, GOOD, '(4) a normal stop keeps the summary'); A.ok(!('rejected' in o), '(4) and carries no rejected field');
    o = await run(() => ({ text: GOOD, done: null }));
    A.eq(o.summary, GOOD, '(4) a stream with no done event is not guessed to be cut');
    o = await run(() => ({ text: GOOD, done: { finishReason: 'error' } }));
    A.eq(o.summary, GOOD, '(4) an unrecognized upstream reason (normalized "error") is not treated as cut — same as the loop');
  }

  // ---- (5) chunked: a cut in chunk 2 of N rejects the whole fold; nothing after it is requested ----
  {
    const big = [];
    for (let i = 1; i <= 60; i++) big.push({ role: i % 2 ? 'user' : 'assistant', content: 'M' + i + ' ' + 'w'.repeat(990) });
    const s = scriptedStream((n) => n === 2 ? { text: CUT, done: { finishReason: 'length' } } : { text: 'SUM#' + n + '\n## Completed\n- ok', done: { finishReason: 'stop' } });
    const o = await makeSummarizer({ streamFn: s.streamFn, cost, model: 'm', chunkChars: 10000, summaryPrompt: () => 'P' })(big, '', null);
    A.ok(o.chunks >= 4, '(5) the slice really is multi-chunk (' + o.chunks + ')');
    A.eq(s.reqs.length, 2, '(5) no chunk after the cut one was requested');
    A.eq(o.summary, '', '(5) chunk 1\'s good summary is NOT shipped as the fold');
    A.eq(o.rejected, 'length', '(5) the whole fold reports rejected:length');
    A.ok(Math.abs(o.usd - 2 * SUM_USD) < 1e-9, '(5) both calls\' spend is reported');
    // the LAST chunk cut: the merged-so-far summary must not be committed either
    const last = partition(big, 10000).length;
    const s3 = scriptedStream((n) => n === last ? { text: REFUSAL, done: { finishReason: 'stop' } } : { text: 'SUM#' + n + '\n## Completed', done: { finishReason: 'stop' } });
    const o3 = await makeSummarizer({ streamFn: s3.streamFn, cost, model: 'm', chunkChars: 10000, summaryPrompt: () => 'P' })(big, '', null);
    A.eq(s3.reqs.length, last, '(5) every chunk was requested when only the last one fails');
    A.eq(o3.summary, '', '(5) a refused LAST chunk rejects the fold (no stale merged summary committed)');
    A.eq(o3.rejected, 'refusal', '(5) reported as rejected:refusal');
  }

  // ---- (6) aux floor: a cut AUX summary retries exactly once on the run model ----
  {
    const older = seedMessages().slice(1);
    let s = scriptedStream((n, req) => req.model === 'aux' ? { text: CUT, done: { finishReason: 'length' } } : { text: GOOD, done: { finishReason: 'stop' } });
    let o = await makeSummarizer({ streamFn: s.streamFn, cost, model: 'run', auxModelFor: () => 'aux', summaryPrompt: () => 'P' })(older, '', null);
    A.eq(s.reqs.map(q => q.model), ['aux', 'run'], '(6) cut aux output -> one retry on the run model');
    A.eq(o.summary, GOOD, '(6) the run model\'s good summary is used');
    A.ok(Math.abs(o.usd - 2 * SUM_USD) < 1e-9, '(6) both calls are billed');
    s = scriptedStream(() => ({ text: REFUSAL, done: { finishReason: 'stop' } }));
    o = await makeSummarizer({ streamFn: s.streamFn, cost, model: 'run', auxModelFor: () => 'aux', summaryPrompt: () => 'P' })(older, '', null);
    A.eq(s.reqs.map(q => q.model), ['aux', 'run'], '(6) both refusing -> still only ONE retry');
    A.eq(o.rejected, 'refusal', '(6) and the fold is rejected');
    // a thrown aux call still takes the original floor path (and a cut run-model retry is NOT retried again)
    let n2 = 0;
    const thrower = async function* (req) { n2++; if (req.model === 'aux') throw new Error('aux down'); yield { type: 'text', delta: CUT }; yield { type: 'done', finishReason: 'length' }; };
    o = await makeSummarizer({ streamFn: thrower, cost, model: 'run', auxModelFor: () => 'aux', summaryPrompt: () => 'P' })(older, '', null);
    A.eq(n2, 2, '(6) aux throw -> one run-model retry, and its cut result is not retried a second time');
    A.eq(o.rejected, 'length', '(6) the cut retry rejects the fold');
  }

  // ---- (7) the refusal heuristic is conservative ----
  {
    A.ok(looksLikeRefusal(REFUSAL), '(7) the audit probe\'s refusal is detected');
    A.ok(looksLikeRefusal('I cannot help with summarizing this conversation.'), '(7) "I cannot ..." is detected');
    A.ok(looksLikeRefusal('"Sorry, I can\'t do that."'), '(7) a quoted "Sorry, ..." is detected');
    A.ok(looksLikeRefusal('I’m unable to provide that summary.'), '(7) curly-apostrophe "I’m unable" is detected');
    A.ok(!looksLikeRefusal(GOOD), '(7) a structured summary is not a refusal');
    A.ok(!looksLikeRefusal("## Goal\nI'm sorry-proof: the user asked for X\n## Completed\n- done"), '(7) a structured summary that contains an apology is not a refusal');
    A.ok(!looksLikeRefusal("I'm sorry to report the build failed twice; the user then fixed the path and tests passed. " + 'x'.repeat(400)), '(7) a LONG text opening with an apology is not rejected');
    A.ok(!looksLikeRefusal('The user asked to audit config files; I cannot find VALUE_03 in any of them.'), '(7) a refusal phrase mid-text does not trip it');
    A.ok(!looksLikeRefusal('Sorryville.txt was read; it holds VALUE_09=kappa.'), '(7) a word merely starting with "sorry" does not trip it');
    A.ok(!looksLikeRefusal(''), '(7) empty is not a refusal (empty has its own path)');
    A.eq(rejectReason(GOOD, 'stop', false), null, '(7) rejectReason: clean stop -> null');
    A.eq(rejectReason(GOOD, 'tool_calls', false), null, '(7) rejectReason: tool_calls finish is not a cut');
  }

  // ---- (8) a normal summary still folds through the real loop ----
  {
    // one model turn: exactly one fold, the preflight before it (alwaysFold would fold again on every later turn)
    const r = await runWith(() => ({ text: GOOD, done: { finishReason: 'stop' } }), [stopTurn]);
    A.eq(r.res.reason, 'done', '(8) the run completes');
    const ev = r.seq.filter(e => e.name === 'agent.compact');
    A.ok(ev.length === 1 && ev[0].payload.reason === 'context', '(8) a clean summary still folds (reason context)');
    const note = noteOf(r.messages);
    A.ok(note && note.content.indexOf('VALUE_01=alpha') >= 0, '(8) the committed note is the real summary');
    A.ok(!r.messages.some(m => /^old-1 /.test(String(m.content || ''))), '(8) the folded raw turns left the prompt');
    A.ok(r.res.usd >= SUM_USD - 1e-9, '(8) a successful fold is billed as before');
  }

  A.report('summarizer.guards.test');
})().catch(e => { console.error(e); process.exit(1); });
