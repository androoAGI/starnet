/* node test/fold-head-pin.test.js — a fold never pins a STALE first message (context-budget-and-fold, step 1).

   The bug (probe 11-04): maybeCompact pinned the FIRST non-system message of the working set verbatim, whatever it was.
   In a long chat that message is turn 1 of the conversation, not this run's task: it rode every post-fold prompt
   forever, byte for byte, while the summarizer never saw it ("Request 1 www..." in a 21-turn chat). The pin existed so
   the rebuilt prompt always opens on a user turn; the run's OWN request (loop.js runRequest, carried whole as the
   'current task' by compaction-fidelity) is the only message that earns a pin by being the request. Now:
     - the first non-system message is pinned when it IS the run's request (a single-directive agentic run);
     - otherwise it folds like any older turn: the summarizer sees it and its words ride the verbatim user section once;
     - the user-start rule replaces the old guarantee WITHOUT moving the cut. For a fold that REMOVES messages, when the
       tail would open on an assistant turn: the run's request, if it sits inside the folded slice, is pinned at the head
       (a run already working in a long chat); otherwise the last user message of the slice, the question the tail's
       first reply answers. That turn is the chat's first message only when the cut falls inside the first exchange;
     - THE CUT NEVER MOVES (probe 11-04: the first cut of this rule moved it back to a user message). A cut inside an
       earlier exchange with several tool pairs would then pull that whole exchange into the tail, and when the chat's
       first message was the slice's only user turn nothing folded at all, where the old pin folded the tool pairs. Every
       fold the old pin made is still made, over the same planned slice (the pinned turn aside), with the planner's tail
       untouched;
     - the free micro tier removes nothing, so it still sees the whole slice.

   CLASS SWEEP over the real runAgentLoop + makeContext: chats of 1, 2 and 20 earlier turns; plain, with a tool pair in
   every second exchange, and with three bulky tool pairs in the FIRST exchange; the run's request last or followed by
   two tool pairs (a run already working); every tail size from 1 to 5 messages (so the tail starts on a user turn in
   some and on an assistant turn in others). The expected cut is computed from the context's own planCompaction plus the
   documented rule and each fold is compared with it; the old pin's own plan is computed beside it as the floor.
   Deterministic, no network. */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const STALE = 'STALE-FIRST-7f3a';
const ASK = 'LATEST-ASK-91bc';
const WINDOW = 4000;                 // threshold 2600 tokens: every fixture below is ~3.6k tokens
const count = (hay, needle) => hay.split(needle).length - 1;
const isNote = m => !!m && m.role === 'system' && /^<conversation_summary>/.test(String(m.content));
const nonSystem = msgs => msgs.filter(m => m && m.role !== 'system');
const firstNonSystem = msgs => nonSystem(msgs)[0];
const READ_TOOL = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
const call = id => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] });

// n earlier exchanges (each: a short user turn, tool pairs by `shape`, a reply), the run's request, then `runPairs` tool
// pairs the run itself has already made. shape: 'plain' = no tools, long replies; 'even' = a small tool pair in every
// second exchange, long replies; 'first' = three BULKY tool pairs in the first exchange, short replies (for a small tail
// the cut then falls inside that exchange: the old pin folded those tool pairs, so must the new rule)
function chat(n, shape, runPairs) {
  const bulk = shape === 'first' ? 'w'.repeat(40) : 'w'.repeat(Math.ceil(13000 / n));
  const msgs = [{ role: 'system', content: 'You are a station agent.' }];
  for (let k = 1; k <= n; k++) {
    msgs.push({ role: 'user', content: k === 1 ? 'Request 1: ' + STALE : 'Request ' + k + ': question number ' + k });
    if (shape === 'even' && k % 2 === 0) { msgs.push(call('c' + k)); msgs.push({ role: 'tool', tool_call_id: 'c' + k, content: 'result ' + k }); }
    if (shape === 'first' && k === 1) for (let t = 1; t <= 3; t++) { msgs.push(call('f' + t)); msgs.push({ role: 'tool', tool_call_id: 'f' + t, content: 'first result ' + t + ' ' + 'T'.repeat(4000) }); }
    msgs.push({ role: 'assistant', content: 'Reply ' + k + ' ' + bulk });
  }
  msgs.push({ role: 'user', content: 'Now: ' + ASK });
  for (let k = 1; k <= runPairs; k++) { msgs.push(call('r' + k)); msgs.push({ role: 'tool', tool_call_id: 'r' + k, content: 'run result ' + k }); }
  return msgs;
}

// the documented cut: the context's own plan, then the user-start rule (restated independently of loop.js). The cut is the
// planner's, always; only a pinned user turn leaves the folded slice
function expectedCut(ctx, history, request) {
  const raw = ctx.planCompaction(history, {});
  if (!raw.older.length) return { older: [], tail: raw.tail, keep: null };
  const head = raw.tail.find(m => m.role !== 'system');
  if (head && head.role !== 'user') {
    let keep = raw.older.indexOf(request) >= 0 ? request : null;
    for (let k = raw.older.length - 1; !keep && k >= 0; k--) if (raw.older[k].role === 'user') keep = raw.older[k];
    if (keep) return { older: raw.older.filter(m => m !== keep), tail: raw.tail, keep };
  }
  return { older: raw.older, tail: raw.tail, keep: null };
}

async function oneFold(seed, keepTail) {
  const ctx = makeContext({ contextLimit: WINDOW, compactAt: 0.65, keepTail });
  const requests = [], folded = [], events = [];
  const messages = seed.slice();
  const provider = { priceOf: () => null, contextLimit: () => WINDOW, stream: async function* (req) {
    requests.push(req.messages.slice());
    yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' };
  } };
  const res = await runAgentLoop({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
    emit: (n, p) => { if (n === 'agent.compact') events.push(p); },
    summarize: async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; },
    microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 4 }, contextLimit: WINDOW });
  return { res, requests, folded, events };
}

(async () => {
  // ---- 1. THE CLASS: every chat shape x every tail size, the run's request last or already working ----
  let folds = 0, requestPinned = 0, splitPinned = 0, firstPinned = 0, firstFolded = 0, nothing = 0, floorChecked = 0;
  for (const n of [1, 2, 20]) for (const shape of ['plain', 'even', 'first']) for (const runPairs of [0, 2]) for (let keepTail = 1; keepTail <= 5; keepTail++) {
    const tag = 'n=' + n + ' ' + shape + (runPairs ? '+run' : '') + ' tail=' + keepTail;
    const seed = chat(n, shape, runPairs);
    const request = seed.find(m => m.role === 'user' && String(m.content).indexOf(ASK) >= 0);
    const probe = makeContext({ contextLimit: WINDOW, compactAt: 0.65, keepTail });
    A.ok(probe.estimateMessages(seed) > 0.65 * WINDOW, tag + ': the fixture is over the fold line (' + probe.estimateMessages(seed) + ')');
    const want = expectedCut(probe, seed.slice(1), request);
    // the slice the OLD head pin folded: the first message pinned, the planner over everything after it
    const old = probe.planCompaction(seed.slice(2), {});
    const { res, requests, folded } = await oneFold(seed, keepTail);
    A.eq(res.reason, 'done', tag + ': the run completes');
    const sent = requests[0];
    // THE FLOOR: a fold the old pin made is still made (the first cut of the user-start rule moved the cut and lost them)
    if (old.older.length) { floorChecked++; A.eq(folded.length, 1, tag + ': a fold the old head pin made (' + old.older.length + ' messages) is still made'); }
    if (!want.older.length) {
      nothing++;
      A.eq(old.older.length, 0, tag + ': nothing foldable only where the old pin folded nothing either');
      A.eq(folded.length, 0, tag + ': nothing foldable -> no paid summarizer call');
      A.ok(sent.length === seed.length && sent.every((m, i) => m === seed[i]), tag + ': and the prompt goes out untouched');
      continue;
    }
    folds++;
    if (want.keep === request) requestPinned++; else if (want.keep) splitPinned++;
    A.eq(folded.length, 1, tag + ': one fold');
    A.ok(folded[0].length === want.older.length && folded[0].every((m, i) => m === want.older[i]), tag + ': the summarizer received exactly the planned slice, the pinned turn aside (' + folded[0].length + ' of ' + want.older.length + ')');
    A.ok(!want.keep || !folded[0].some(m => m === want.keep), tag + ': a pinned turn is never summarized');
    const wire = JSON.stringify(sent);
    const head = firstNonSystem(sent);
    if (want.keep === seed[1]) {
      // the cut falls inside the FIRST exchange: its question is the turn the tail's first reply answers, so it is the pin
      firstPinned++;
      A.ok(head === seed[1], tag + ': the cut splits the first exchange: its question is the pinned turn');
    } else {
      firstFolded++;
      A.ok(folded[0][0] === seed[1], tag + ': the summarizer\'s slice STARTS with the first chat message (it was not pinned away)');
      A.ok(!sent.some(m => m.role !== 'system' && String(m.content).indexOf(STALE) >= 0), tag + ': the stale first message is not a message of the prompt');
    }
    A.eq(count(wire, STALE), 1, tag + ': the first message\'s words ride the request exactly once (pinned or in the verbatim user section)');
    A.eq(count(wire, ASK), 1, tag + ': the run\'s latest message is present exactly once');
    A.eq(sent.filter(isNote).length, 1, tag + ': exactly one summary note');
    A.eq(head && head.role, 'user', tag + ': the rebuilt prompt opens on a user turn');
    if (want.keep) {
      A.ok(head === want.keep, tag + ': ' + (want.keep === request ? 'the run\'s request, folded out of the slice,' : 'the turn the cut splits') + ' is pinned at the head');
      A.eq(sent.indexOf(want.keep) + 1, sent.findIndex(isNote), tag + ': and the note sits right after it (the pinned-directive shape)');
    } else {
      A.eq(sent[sent.length - runPairs * 2 - 1].content, 'Now: ' + ASK, tag + ': the request rides the tail');
    }
    // THE CUT NEVER MOVES: what follows the pinned turn is the planner's tail, the same objects in the same order
    const out = nonSystem(sent), tail = nonSystem(want.tail);
    A.ok(out.length === (want.keep ? 1 : 0) + tail.length && out.slice(out.length - tail.length).every((m, i) => m === tail[i]), tag + ': the planner\'s tail goes out untouched');
  }
  A.ok(folds >= 60, 'the sweep really folds (' + folds + ' folds, ' + nothing + ' nothing-foldable cuts)');
  A.ok(splitPinned >= 10, 'the sweep includes tails that start on an assistant turn whose question (not the request) is pinned (' + splitPinned + ')');
  A.ok(requestPinned >= 8, 'the sweep includes runs already working, whose request is pinned at the head (' + requestPinned + ')');
  A.ok(firstPinned >= 3, 'the sweep includes cuts inside the first exchange, where its tool pairs still fold (' + firstPinned + ')');
  A.ok(firstFolded >= 30, 'the sweep includes chats whose stale first message folds into the verbatim section (' + firstFolded + ')');
  A.ok(nothing >= 4, 'the sweep includes slices the pinned turn leaves empty (nothing foldable, as the old pin left them)');
  A.ok(floorChecked >= 40, 'the floor was checked against the old pin\'s plan on ' + floorChecked + ' shapes');

  // ---- 2. A SINGLE DIRECTIVE IS STILL PINNED, BYTE FOR BYTE (the first message IS the run's request) ----
  {
    const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTailTurns: 2 });
    const directive = { role: 'user', content: 'THE DIRECTIVE: read every file and report the tokens' };
    const requests = [], folded = [];
    let turn = 0;
    const provider = { priceOf: () => null, contextLimit: () => 10, stream: async function* (req) {
      turn++;
      const est = ctx.estimateMessages(req.messages);
      requests.push(req.messages.slice());
      if (turn <= 5) {
        yield { type: 'tool_start', index: 0, id: 'c' + turn, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'REPORT' }; yield { type: 'done', finishReason: 'stop' };
    } };
    const res = await runAgentLoop({ messages: [{ role: 'system', content: 'sys' }, directive], provider, tools: READ_TOOL, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      dispatch: async (c) => ({ ok: true, content: 'file ' + c.id }), emit: () => {},
      summarize: async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; },
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 10 }, contextLimit: 10 });
    A.eq(res.reason, 'done', 'single directive: the run completes');
    A.ok(folded.length >= 1, 'single directive: it folded (' + folded.length + ')');
    A.ok(!folded.some(older => older.some(m => m === directive)), 'single directive: the summarizer never received the directive');
    const first = requests.find(r => r.some(isNote));
    A.ok(first && first[1] === directive, 'single directive: the directive is the SAME object right after the system prefix');
    A.eq(first.indexOf(first.find(isNote)), 2, 'single directive: the note sits right after the pinned directive');
    // the whole rebuilt prompt, frozen from the pre-change code (4152883a1): this leg is a lock and is green on both sides
    const GOLDEN = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'THE DIRECTIVE: read every file and report the tokens' },
      { role: 'system', content: '<conversation_summary>\nS\n</conversation_summary>' },
      call('c2'), { role: 'tool', tool_call_id: 'c2', content: 'file c2' },
      call('c3'), { role: 'tool', tool_call_id: 'c3', content: 'file c3' }
    ];
    A.eq(JSON.stringify(first), JSON.stringify(GOLDEN), 'single directive: the rebuilt prompt is byte-identical to the one the pre-change code built');
  }

  // ---- 3. AN AGENTIC RUN IN A LONG CHAT, fold after fold ----
  const agentic = async (seed, turns) => {
    const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTailTurns: 2 });
    const requests = [], folded = [];
    let turn = 0;
    const provider = { priceOf: () => null, contextLimit: () => 10, stream: async function* (req) {
      turn++;
      const est = ctx.estimateMessages(req.messages);
      requests.push(req.messages.slice());
      if (turn <= turns) {
        yield { type: 'tool_start', index: 0, id: 'g' + turn, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'REPORT' }; yield { type: 'done', finishReason: 'stop' };
    } };
    const res = await runAgentLoop({ messages: seed, provider, tools: READ_TOOL, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      dispatch: async (c) => ({ ok: true, content: 'file ' + c.id }), emit: () => {},
      summarize: async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; },
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 14 }, contextLimit: 10 });
    return { res, requests, folded };
  };
  {
    // (a) a fresh run: nothing is foldable at request #1; the first fold takes the stale message and leaves the request
    const staleMsg = { role: 'user', content: 'Request 1: ' + STALE };
    const request = { role: 'user', content: 'Now: ' + ASK };
    const { res, requests, folded } = await agentic([{ role: 'system', content: 'sys' }, staleMsg, { role: 'assistant', content: 'ack' }, request], 6);
    A.eq(res.reason, 'done', 'agentic run in a chat: the run completes');
    A.ok(folded.length >= 2, 'agentic run in a chat: it folded more than once (' + folded.length + ')');
    A.ok(folded[0][0] === staleMsg && !folded[0].some(m => m === request), 'agentic run in a chat: the first fold takes the stale first message and leaves the run\'s request alone');
    A.ok(requests[0].some(m => m === staleMsg), 'agentic run in a chat: request #1 (nothing foldable yet) still carries the whole chat');
    const afterFirst = requests.find(r => r.some(isNote));
    A.ok(afterFirst && firstNonSystem(afterFirst) === request, 'agentic run in a chat: after the first fold the prompt opens on the run\'s request');
    A.eq(count(JSON.stringify(afterFirst), STALE), 1, 'agentic run in a chat: the stale words ride the note once');
    A.ok(!folded.slice(1).some(older => older.some(m => m === request)), 'agentic run in a chat: later folds never take the run\'s request');
    const last = requests[requests.length - 1];
    A.eq(count(JSON.stringify(last), ASK), 1, 'agentic run in a chat: the request is present exactly once in the last prompt');
    A.eq(count(JSON.stringify(last), STALE), 1, 'agentic run in a chat: and the stale words still exactly once');
    A.eq(firstNonSystem(last).role, 'user', 'agentic run in a chat: the last prompt still opens on a user turn');
  }
  {
    // (b) a run already working when the fold comes (a resumed one): the request is INSIDE the slice and the tail opens on
    //     an assistant turn, so the request is pinned at the head and everything else of the chat folds
    const staleMsg = { role: 'user', content: 'Request 1: ' + STALE };
    const request = { role: 'user', content: 'Now: ' + ASK };
    const seed = [{ role: 'system', content: 'sys' }, staleMsg, { role: 'assistant', content: 'ack' }, request,
      call('p1'), { role: 'tool', tool_call_id: 'p1', content: 'file p1' }, call('p2'), { role: 'tool', tool_call_id: 'p2', content: 'file p2' },
      call('p3'), { role: 'tool', tool_call_id: 'p3', content: 'file p3' }, call('p4'), { role: 'tool', tool_call_id: 'p4', content: 'file p4' }];
    const { res, requests, folded } = await agentic(seed, 3);
    A.eq(res.reason, 'done', 'resumed run in a chat: the run completes');
    A.ok(folded.length >= 1 && folded[0][0] === staleMsg && !folded[0].some(m => m === request), 'resumed run in a chat: the first fold takes the stale message, never the request');
    A.ok(folded[0].some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls[0].id === 'p1'), 'resumed run in a chat: and the run\'s own early tool turns (the part the old pin left folded too)');
    const first = requests.find(r => r.some(isNote));
    A.ok(first && first[1] === request && isNote(first[2]), 'resumed run in a chat: the post-fold prompt is system, request, note');
    A.eq(count(JSON.stringify(first), STALE), 1, 'resumed run in a chat: the stale words ride the note once');
    A.eq(count(JSON.stringify(first), ASK), 1, 'resumed run in a chat: the request exactly once');
    for (const r of requests.filter(q => q.some(isNote))) {
      A.ok(r[1] === request && isNote(r[2]), 'resumed run in a chat: every later prompt keeps the request pinned (same object) right before the note');
      A.eq(count(JSON.stringify(r), ASK), 1, 'resumed run in a chat: and says it once');
    }
  }
  {
    // (c) a RECOVERED computer-use run: the checkpoint ends on screen-capture turns, which are user-role messages built
    //     from a tool's pixels and nobody's request. The pin stays on the directive that started the work, never on the
    //     last capture (which would have left the directive an ordinary, foldable turn)
    const directive = { role: 'user', content: 'THE DIRECTIVE: open the dashboard and read the totals' };
    const capture = n => ({ role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE — the actual pixel output]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' + n } }] });
    const seed = [{ role: 'system', content: 'sys' }, directive];
    for (let k = 1; k <= 4; k++) { seed.push(call('s' + k)); seed.push({ role: 'tool', tool_call_id: 's' + k, content: 'shot ' + k }); seed.push(capture(k)); }
    const { res, requests, folded } = await agentic(seed, 2);
    A.eq(res.reason, 'done', 'recovered computer-use run: the run completes');
    A.ok(folded.length >= 1, 'recovered computer-use run: it folded (' + folded.length + ')');
    A.ok(!folded.some(older => older.some(m => m === directive)), 'recovered computer-use run: the summarizer never received the directive');
    const noted = requests.filter(q => q.some(isNote));
    A.ok(noted.length >= 1 && noted.every(q => firstNonSystem(q) === directive), 'recovered computer-use run: every post-fold prompt opens on the directive (the same object)');
    A.ok(noted.every(q => count(JSON.stringify(q), 'THE DIRECTIVE') === 1), 'recovered computer-use run: and says it once');
  }

  // ---- 4. THE FREE TIER STILL SEES THE WHOLE SLICE: a run that follows a chat elides its own old tool results ----
  {
    const WIN = 20000, big = n => ({ role: 'tool', tool_call_id: 'm' + n, content: 'BODY' + n + ' ' + 'x'.repeat(20000) });
    const seed = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Request 1: ' + STALE }, { role: 'assistant', content: 'ack' }, { role: 'user', content: 'Now: ' + ASK }];
    for (let k = 1; k <= 4; k++) { seed.push(call('m' + k)); seed.push(big(k)); }
    const ctx = makeContext({ contextLimit: WIN, compactAt: 0.65, keepTail: 2 });
    A.ok(ctx.estimateMessages(seed) > 0.65 * WIN, 'micro fixture is over the fold line (' + ctx.estimateMessages(seed) + ')');
    const events = []; let paid = 0, sent = null;
    const provider = { priceOf: () => null, contextLimit: () => WIN, stream: async function* (req) { if (!sent) sent = req.messages.slice(); yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; } };
    const messages = seed.slice();
    await runAgentLoop({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx, emit: (n, p) => { if (n === 'agent.compact') events.push(p); },
      summarize: async () => { paid++; return { summary: 'S', usd: 0, tokens: 0 }; }, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 4 }, contextLimit: WIN });
    A.eq(events.map(e => e.reason).join(','), 'micro', 'micro tier: the first (and only) compaction is the free elision');
    A.eq(paid, 0, 'micro tier: no paid summarizer call');
    A.eq(sent.length, seed.length, 'micro tier: it removed no message');
    A.ok(sent.slice(0, 4).every((m, i) => m === seed[i]), 'micro tier: and moved none (the chat, the request, in order)');
    A.ok(sent.filter(m => m.role === 'tool' && /^\[tool result elided/.test(String(m.content))).length >= 2, 'micro tier: older tool results of the run itself were elided');
  }

  A.report('fold-head-pin.test');
})().catch(e => { console.error(e); process.exit(1); });
