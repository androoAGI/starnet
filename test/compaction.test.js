/* node test/compaction.test.js — H5.2 iterative-merge + savings anti-thrash in the agent loop.
   (1) A run that already carries a prior <conversation_summary> note MERGES it (the summarizer receives the prior
       text as prevSummary) and ends with EXACTLY ONE note — successive folds never stack.
   (2) When folds stop freeing meaningful space (<10% each), compaction switches OFF after two in a row, so a long
       run can't burn endless paid summarizer calls re-folding the same near-incompressible prompt.
   Driven through the real runAgentLoop with a replay provider + an injected context (deterministic, no network).
   maybeCompact fires at the TOP of each loop iteration, so the run needs tool-call turns (which keep iterating)
   for a fold to occur on a later turn against the prior turn's usage. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

function setup() { const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); return { seq, emit: makeEmitter(bus, () => {}) }; }
const openCtx = () => ({ agentId: 'a', canUse: () => ({ ok: true }), canRun: () => ({ ok: true }) });
// a tool-call turn keeps the loop iterating; carries the prompt-token usage maybeCompact measures next turn
const toolTurn = (id, p) => [{ type: 'tool_start', index: 0, id, name: 'noop' }, { type: 'tool_args', index: 0, chunk: '{}' },
  { type: 'usage', usage: { prompt_tokens: p, completion_tokens: 1, total_tokens: p + 1 } }, { type: 'done', finishReason: 'tool_calls' }];
const stopTurn = [{ type: 'text', delta: 'final' }, { type: 'done', finishReason: 'stop' }];
function reg() { const r = makeRegistry(); r.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => 'ok' }); return r; }

(async () => {
  // ---- 1. ITERATIVE MERGE: a prior summary note is merged, not stacked; exactly one note survives ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 8), stopTurn] });   // 8 > 6.5 -> fold on iter 2
    const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    const R = reg();
    let gotPrev = null, calls = 0;
    // the FIRST fold is the one that merges the seeded note (the preflight fold before request #1 — the history is
    // already over this 10-token window); later folds merge the running summary that fold produced
    const summarize = async (older, prevSummary) => { calls++; if (gotPrev === null) gotPrev = prevSummary; return { summary: 'MERGED', usd: 0, tokens: 0 }; };
    const messages = [
      { role: 'system', content: '<conversation_summary>\nOLD RUNNING SUMMARY\n</conversation_summary>' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }
    ];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'run completes');
    A.ok(calls >= 1, 'a fold happened');
    A.eq(gotPrev, 'OLD RUNNING SUMMARY', 'the prior summary text was passed to the summarizer to MERGE');
    const notes = messages.filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('<conversation_summary>') === 0);
    A.eq(notes.length, 1, 'exactly ONE conversation_summary note after the fold (merged, not stacked)');
    A.ok(/MERGED/.test(notes[0].content) && notes[0].content.indexOf('OLD RUNNING SUMMARY') === -1, 'the surviving note is the new merged summary, the old raw note is gone');
  }

  // ---- 2. SAVINGS ANTI-THRASH: two <10% folds in a row -> compaction turns off (paid calls bounded) ----
  {
    const { seq, emit } = setup();
    const ctx = {                                                   // injected context whose folds barely shrink
      shouldCompact: () => true,
      estimateMessages: () => 96,                                   // after(96) vs before(100 from usage) -> 4% savings
      planCompaction: (arr) => ({ older: arr.slice(0, Math.max(1, arr.length - 1)), tail: arr.slice(Math.max(1, arr.length - 1)) })
    };
    const R = reg();
    let calls = 0;
    const summarize = async () => { calls++; return { summary: 'S', usd: 0, tokens: 0 }; };
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 100), toolTurn('c2', 100), toolTurn('c3', 100), toolTurn('c4', 100), stopTurn] });
    const messages = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'run completes');
    const compacts = seq.filter(e => e.name === 'agent.compact').length;
    A.eq(calls, 2, 'summarizer called exactly twice — compaction switched off after two sub-10% folds');
    A.eq(compacts, 2, 'exactly two agent.compact events despite four threshold-crossing tool turns');
  }

  // ---- 3. THE RUN'S OWN REQUEST IS PINNED + TAIL IN TURNS. The pin used to be "the first non-system message": right for a
  //         single directive, wrong in a chat, where the first message is turn 1 of the conversation and the run's task
  //         is the latest user message. Now the pin is the run's request (loop.js runRequest, by identity). ----
  {
    const big = 'B'.repeat(4000);   // big tool results: the micro tier alone cannot clear a 10-token window
    const bigTool = () => { const R = makeRegistry(); R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => big }); return R; };
    const replay = () => makeReplayProvider({ turns: [toolTurn('c1', 100), toolTurn('c2', 100), toolTurn('c3', 100), toolTurn('c4', 100), stopTurn] });
    const afterNote = (messages) => { const noteIdx = messages.findIndex(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content))); return { noteIdx, rest: messages.slice(noteIdx + 1).filter(m => m.role !== 'system') }; };
    const turnsOf = (rest) => { let groups = 0; for (let k = 0; k < rest.length; k++) if (rest[k].role !== 'tool') groups++; return groups; };

    // (a) A SINGLE DIRECTIVE (the first message IS the run's request): pinned byte-identical, the summarizer never sees
    //     it, the verbatim tail holds >= keepTailTurns turns
    {
      const { seq, emit } = setup();
      const R = bigTool(), provider = replay();
      const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTailTurns: 2 });
      const folded = [];
      const summarize = async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; };
      const directive = { role: 'user', content: 'THE DIRECTIVE: read every file and report the tokens' };
      const messages = [{ role: 'system', content: 'sys' }, directive];
      const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
      A.eq(res.reason, 'done', 'run completes');
      A.ok(folded.length >= 1, 'at least one LLM fold happened (' + folded.length + ')');
      A.eq(messages[0], { role: 'system', content: 'sys' }, 'leading system prefix verbatim');
      A.ok(messages[1] === directive, 'the directive is pinned: the SAME object, right after the system prefix, after the fold(s)');
      A.ok(!folded.some(older => older.some(m => m === directive || String(m.content).indexOf('THE DIRECTIVE') >= 0)), 'the summarizer never received the directive');
      A.ok(folded[0].some(m => m.role === 'assistant' && Array.isArray(m.tool_calls)), "the run's own turns AFTER the directive were folded");
      A.ok(seq.some(e => e.name === 'agent.compact' && e.payload.reason === 'context'), 'an LLM fold was emitted');
      const { noteIdx, rest } = afterNote(messages);
      A.ok(noteIdx === 2, 'the summary note sits right after the pinned directive');
      A.ok(turnsOf(rest) >= 2, 'the verbatim tail holds >= keepTailTurns (2) turns — got ' + turnsOf(rest) + ' (' + rest.map(m => m.role).join(',') + ')');
      A.ok(folded[folded.length - 1].length >= 1, 'the last fold folded something');
    }

    // (b) A CHAT'S STALE FIRST MESSAGE IS NOT PINNED: the run's request is the latest user message. The stale first message
    //     folds like any older turn (the summarizer sees it; its words ride the note's verbatim user section ONCE), and the
    //     run's request is the pin
    {
      const { emit } = setup();
      const R = bigTool(), provider = replay();
      const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTailTurns: 2 });
      const folded = [];
      const summarize = async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; };
      const stale = { role: 'user', content: 'THE OLD DIRECTIVE: tidy the workshop' };
      const request = { role: 'user', content: 'THE DIRECTIVE: read every file and report the tokens' };
      const messages = [{ role: 'system', content: 'sys' }, stale, { role: 'user', content: 'earlier note' }, { role: 'assistant', content: 'ack' }, request];
      const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
      A.eq(res.reason, 'done', 'chat: run completes');
      A.ok(folded.length >= 1, 'chat: at least one LLM fold happened (' + folded.length + ')');
      A.ok(folded[0].some(m => m === stale), 'chat: the summarizer DID receive the stale first message');
      A.ok(!folded.some(older => older.some(m => m === request)), "chat: and never the run's request");
      A.ok(messages[1] === request, "chat: the run's request is the pin — the SAME object, right after the system prefix");
      A.ok(!messages.some(m => m === stale), 'chat: the stale first message is not kept as a message of its own');
      const note = messages.find(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));
      A.eq(String(note.content).split('THE OLD DIRECTIVE: tidy the workshop').length - 1, 1, "chat: its words ride the note's verbatim user section exactly once");
      A.ok(afterNote(messages).noteIdx === 2, 'chat: the summary note sits right after the pinned request');
      A.ok(turnsOf(afterNote(messages).rest) >= 2, 'chat: the verbatim tail still holds >= keepTailTurns (2) turns');
    }
  }

  // ---- 4. MICRO TIER FIRST: elided tool results clear the threshold -> no summarizer call, reason 'micro' ----
  {
    const { seq, emit } = setup();
    const big = 'C'.repeat(20000);                       // ~5000 tokens of tool output per turn
    const R = makeRegistry(); R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => big });
    // window 20000: threshold 13000 tokens. After the 3rd tool turn the provider reports 14000 -> fires; eliding the
    // results OUTSIDE a 1-turn tail drops the local estimate far under the threshold -> micro clears it.
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 6000), toolTurn('c2', 11000), toolTurn('c3', 14000), stopTurn] });
    const ctx = makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 });
    let llm = 0;
    const summarize = async () => { llm++; return { summary: 'S', usd: 0, tokens: 0 }; };
    const messages = [{ role: 'user', content: 'read things' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'run completes');
    const ev = seq.filter(e => e.name === 'agent.compact');
    A.ok(ev.length >= 1, 'a compaction fired');
    A.eq(ev[0].payload.reason, 'micro', 'the FIRST compaction is the free micro tier');
    A.ok(ev[0].payload.elided >= 1, 'it reports how many tool results it elided');
    A.ok(ev[0].payload.afterTokens < ev[0].payload.beforeTokens, 'and it really shrank the prompt');
    A.eq(llm, 0, 'the paid summarizer was NOT called when micro cleared the threshold');
    const elided = messages.filter(m => m.role === 'tool' && /^\[tool result elided at compaction/.test(String(m.content)));
    A.ok(elided.length >= 1, 'older tool results carry the elision marker');
    A.ok(elided[0].content.indexOf('noop, 20000 bytes; first 240 chars kept below; re-run the tool for the full output]') > 0, 'marker names the tool, the byte size, and what was kept');
    A.ok(/\]\nC{240}…$/.test(elided[0].content), 'the head of the result survives the elision (the fact usually lives there)');
    A.eq(messages[0], { role: 'user', content: 'read things' }, 'directive untouched by the micro tier');
    for (let k = 0; k < messages.length; k++) if (messages[k].role === 'tool') { let j = k - 1; while (j >= 0 && messages[j].role === 'tool') j--; A.eq(messages[j].role, 'assistant', 'tool result ' + k + ' still paired'); }
  }

  // ---- 4b. microCompaction:false (STARNET_COMPACT_MICRO=0) -> the free tier is skipped, the paid fold runs ----
  {
    const { seq, emit } = setup();
    const R = makeRegistry(); R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => 'C'.repeat(20000) });
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 6000), toolTurn('c2', 11000), toolTurn('c3', 14000), stopTurn] });
    const ctx = makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 });
    let llm = 0;
    const summarize = async () => { llm++; return { summary: 'S', usd: 0, tokens: 0, chunks: 3 }; };
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'read things' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize, microCompaction: false });
    A.eq(res.reason, 'done', 'run completes');
    const ev = seq.filter(e => e.name === 'agent.compact');
    A.ok(llm >= 1 && ev.length >= 1 && ev[0].payload.reason === 'context', 'with the micro tier off the first compaction is the paid fold');
    A.eq(ev[0].payload.chunks, 3, 'agent.compact carries the summarizer\'s chunk count (additive field)');
  }

  // ---- 5. BREAKER TRIPPED -> FALLBACK NOTE, NOT A DEAD RUN: two summarizer throws flip compactionOff; the next
  //         threshold crossing folds deterministically (reason 'fallback'), and the run proceeds to 'done' ----
  {
    const { seq, emit } = setup();
    const R = makeRegistry(); R.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => 'r'.repeat(3000) });
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 100), toolTurn('c2', 100), toolTurn('c3', 100), toolTurn('c4', 100), stopTurn] });
    const ctx = { shouldCompact: () => true, estimateMessages: (arr) => arr.reduce((t, m) => t + Math.ceil(String(m.content || '').length / 4) + 4, 0),
      planCompaction: (arr) => ({ older: arr.slice(0, Math.max(0, arr.length - 1)), tail: arr.slice(Math.max(0, arr.length - 1)) }) };
    let calls = 0, drained = 0;
    const summarize = async () => { calls++; throw new Error('summarizer down'); };
    summarize.drain = (older) => { drained += older.length; };
    const messages = [{ role: 'user', content: 'FIRST-ASK' }, { role: 'user', content: 'old-1 ' + 'z'.repeat(2000) }, { role: 'assistant', content: 'old-2 ' + 'z'.repeat(2000) }, { role: 'user', content: 'old-3' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'the run still completes after the summarizer breaker trips');
    A.eq(calls, 2, 'the summarizer was tried exactly twice (breaker at 2)');
    const ev = seq.filter(e => e.name === 'agent.compact');
    A.ok(ev.length >= 1 && ev.every(e => e.payload.reason === 'fallback'), 'every compaction after the breaker is a fallback fold (' + ev.map(e => e.payload.reason).join(',') + ')');
    A.ok(drained > 0, 'the durable-transcript drain still ran for the fallback-folded slice');
    const note = messages.find(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));
    A.ok(note && /compaction fallback/.test(note.content) && /old-1/.test(note.content), 'the fallback note is a deterministic digest of the folded messages');
    // the digest line for a user message points at the (budgeted) verbatim section; it never promises word for word
    A.ok(note.content.indexOf('- user: [see the user messages section below — it marks any message it had to trim or omit]') >= 0, 'a user line points at the user messages section');
    A.ok(!/carried word for word in the user messages section/.test(note.content), 'and no digest line claims the section carries it word for word');
    // the pin is the run's OWN request (the newest user message), not the chat's first message: that one folded, and its
    // words ride the digest's verbatim user section exactly once
    A.eq(messages[0], { role: 'user', content: 'old-3' }, "the run's own request stays pinned");
    A.eq(note.content.split('FIRST-ASK').length - 1, 1, 'and the stale first message rides the verbatim user section once');
  }

  A.report('compaction.test');
})();
