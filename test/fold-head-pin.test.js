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
     - the free micro tier removes nothing, so it still sees the whole slice;
     - A PIN IS A WEIGHT THE FOLD CANNOT REMOVE (review 11-04, legs 5-7): the old pin held the chat's first message only, so a
       big turn in the middle of a chat was always folded. The first cut of the rule pinned whatever turn the cut fell behind,
       however large: a 7k-token paste in an 8k window left the fold nothing to take (6848 -> 6909 tokens, a paid call that
       made the prompt bigger), and a provider that refused the prompt could not be answered at all. Now a turn is pinned only
       when it weighs no more than the verbatim section would carry of it (compaction-fidelity PER_MESSAGE_MAX_CHARS), the
       run's own request no more than that or a quarter of the window; a heavier one folds, its words ride the clipped
       verbatim section as before the lane, and the wire's boundary turn opens the request on a user turn.

   CLASS SWEEP over the real runAgentLoop + makeContext: chats of 1, 2 and 20 earlier turns; plain, with a tool pair in
   every second exchange, and with three bulky tool pairs in the FIRST exchange; the run's request last or followed by
   two tool pairs (a run already working); every tail size from 1 to 5 messages (so the tail starts on a user turn in
   some and on an assistant turn in others). The expected cut is computed from the context's own planCompaction plus the
   documented rule and each fold is compared with it; the old pin's own plan is computed beside it as the floor.
   Deterministic, no network. */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const fidelity = require('../sidecar/compaction-fidelity.js');
const { projectRoles } = require('../sidecar/providers/provider.js');

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

async function oneFold(seed, keepTail, win) {
  win = win || WINDOW;
  const ctx = makeContext({ contextLimit: win, compactAt: 0.65, keepTail });
  const requests = [], folded = [], events = [];
  const messages = seed.slice();
  const provider = { priceOf: () => null, contextLimit: () => win, stream: async function* (req) {
    requests.push(req.messages.slice());
    yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' };
  } };
  const res = await runAgentLoop({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
    emit: (n, p) => { if (n === 'agent.compact') events.push(p); },
    summarize: async (older) => { folded.push(older); return { summary: 'S', usd: 0, tokens: 0 }; },
    microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 4 }, contextLimit: win });
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

  // ---- 5. A BULKY USER TURN IS FOLDED, NOT PINNED: the class (review 11-04) ----
  // The question the cut falls behind used to be pinned whatever its size. Every shape below puts the cut right behind a paste
  // (the tail opens on the paste's reply), from one line under the verbatim cap to a turn that is most of the window. The
  // invariants hold on the code before the lane (the old pin held only the chat's first message) and must hold after it:
  // a heavy turn is not a message of the prompt, the summarizer received it, its words ride the verbatim section once, a fold
  // never grows the prompt, the prompt is no larger than the old head pin's own plus one light turn, and the request the wire
  // builds opens on a user turn. A turn at or under the cap is still pinned (the lane's rule, legs 1-3).
  const PASTE = 'GIANT-PASTE-3c9e';
  const capTokens = ctx => ctx.estimateMessages([{ role: 'user', content: 'x'.repeat(fidelity.PER_MESSAGE_MAX_CHARS) }]);   // what the verbatim section carries of one message
  const isPaste = m => !!m && m.role === 'user' && String(m.content).startsWith(PASTE);
  // six small exchanges with bulky replies, the paste turn (`chars` long, with a tool pair when `tools`) and its reply, `after`
  // small exchanges, then the run's request
  function bulky(chars, after, tools) {
    const m = [{ role: 'system', content: 'You are a station agent.' }];
    const exchange = (user, reply) => { m.push({ role: 'user', content: user }); m.push({ role: 'assistant', content: reply }); };
    for (let k = 1; k <= 6; k++) exchange('Request ' + k + ': question number ' + k, 'Reply ' + k + ' ' + 'r'.repeat(1500));
    m.push({ role: 'user', content: (PASTE + ' ' + 'lorem ipsum dolor '.repeat(Math.ceil(chars / 18))).slice(0, chars) });
    if (tools) { m.push(call('p1')); m.push({ role: 'tool', tool_call_id: 'p1', content: 'what the paste says' }); }
    m.push({ role: 'assistant', content: 'Reply to the paste: I read it.' });
    for (let k = 1; k <= after; k++) exchange('Request ' + (6 + k) + ': follow-up ' + k, 'Reply ' + (6 + k) + ' ' + 'r'.repeat(300));
    m.push({ role: 'user', content: 'Now: ' + ASK });
    return m;
  }
  {
    let heavy = 0, light = 0;
    for (const chars of [3900, 4000, 4001, 4100, 12000]) for (const after of [0, 1, 3]) for (const tools of [false, true]) {
      const tag = 'paste of ' + chars + ' chars, ' + after + ' exchange(s) after' + (tools ? ', tool pair' : '');
      const seed = bulky(chars, after, tools);
      const keepTail = (tools ? 3 : 1) + 2 * after + 1;                       // from the paste's reply (or its tool call) to the request
      const probe = makeContext({ contextLimit: WINDOW, compactAt: 0.65, keepTail });
      const paste = seed.find(isPaste), request = seed[seed.length - 1];
      const before = probe.estimateMessages(seed);
      A.ok(before > 0.65 * WINDOW, tag + ': the fixture is over the fold line (' + before + ')');
      const raw = probe.planCompaction(seed.slice(1), {});
      const head = raw.tail.find(m => m.role !== 'system');
      A.ok(raw.older[raw.older.length - 1] === paste && head && head.role === 'assistant', tag + ': fixture: the cut falls right behind the paste, the tail opens on an assistant turn');
      const { res, requests, folded } = await oneFold(seed, keepTail);
      A.eq(res.reason, 'done', tag + ': the run completes');
      A.eq(folded.length, 1, tag + ': one fold');
      const sent = requests[0], note = sent.find(isNote);
      const fits = probe.estimateMessages([paste]) <= capTokens(probe);
      A.eq(fits, chars <= fidelity.PER_MESSAGE_MAX_CHARS, tag + ': the weight line is the verbatim cap (PER_MESSAGE_MAX_CHARS ' + fidelity.PER_MESSAGE_MAX_CHARS + ' characters)');
      if (fits) {
        light++;
        A.ok(sent[1] === paste && !folded[0].includes(paste), tag + ': a turn the verbatim section would carry whole is pinned at the head');
      } else {
        heavy++;
        A.ok(!sent.includes(paste), tag + ': a heavy turn is not a message of the prompt');
        A.ok(folded[0].includes(paste), tag + ': the summarizer received it');
        A.eq(count(JSON.stringify(sent), PASTE), 1, tag + ': its words ride the request exactly once');
        A.ok(note && new RegExp('\\[user message: first \\d+ of \\d+ chars\\]\\n' + PASTE).test(note.content), tag + ': in the verbatim section, clipped to its share and saying so');
      }
      const afterTokens = probe.estimateMessages(sent);
      A.ok(afterTokens < before, tag + ': a fold never grows the prompt (' + before + ' > ' + afterTokens + ')');
      // the old head pin's post-fold prompt for the same chat: its first message pinned, the planner over everything after it
      const old = probe.planCompaction(seed.slice(2), {});
      const oldNote = { role: 'system', content: '<conversation_summary>\n' + fidelity.joinSummary('S', fidelity.renderUserSection(fidelity.mergeUserMessages(null, fidelity.collectUserMessages(old.older, { pinned: request }), fidelity.userBudgetChars(WINDOW)))) + '\n</conversation_summary>' };
      const oldTokens = probe.estimateMessages([seed[0], seed[1], oldNote].concat(old.tail));
      A.ok(afterTokens <= oldTokens + capTokens(probe), tag + ': and is no larger than the old head pin\'s plus one light turn (' + afterTokens + ' vs ' + oldTokens + ' + ' + capTokens(probe) + ')');
      for (const policy of ['chat', 'native']) {
        const first = projectRoles(sent, policy).find(m => m.role !== 'system');
        A.eq(first && first.role, 'user', tag + ': the request the wire builds opens on a user turn (' + policy + ' roles)');
      }
    }
    A.ok(heavy >= 18 && light >= 12, 'the sweep folds heavy turns (' + heavy + ') and still pins light ones (' + light + ')');
  }

  // ---- 6. A PROVIDER THAT REFUSES THE PROMPT IS ANSWERED BY THE FOLD, whatever the question the cut falls behind weighs ----
  // The provider has a hard window below what the fold line allows (every real one counts more than the local ruler): a chat
  // whose newest big turn is a paste. Before the lane the paste was folded and the run finished; with the paste pinned the
  // forced fold had nothing left to take and every run ended context_overflow. Production context policy (RUN_CONTEXT_DEFAULTS).
  {
    const run = async (WIN, HARD, chars) => {
      const ctx = makeContext(Object.assign({ contextLimit: WIN }, RUN_CONTEXT_DEFAULTS));
      const seed = [{ role: 'system', content: 'You are a station agent.' }];
      for (let k = 1; k <= 3; k++) seed.push({ role: 'user', content: 'Request ' + k + ': small question ' + k }, { role: 'assistant', content: 'Reply ' + k + ' short' });
      seed.push({ role: 'user', content: (PASTE + ' ' + 'lorem ipsum dolor '.repeat(Math.ceil(chars / 18))).slice(0, chars) }, { role: 'assistant', content: 'Reply to the paste: I read it.' }, { role: 'user', content: 'Now: ' + ASK });
      const posts = [], start = ctx.estimateMessages(seed), line = ctx.thresholdTokens();   // read before the run: a refusal that names its window lowers the line
      const provider = { priceOf: () => null, contextLimit: () => WIN, stream: async function* (req) {
        const est = ctx.estimateMessages(req.messages);
        posts.push(est);
        if (est > HARD) { const e = new Error('prompt is too long: ' + est + ' tokens > ' + HARD + ' maximum'); e.status = 400; throw e; }
        yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' };
      } };
      let summarizerCalls = 0;
      const res = await runAgentLoop({ messages: seed.slice(), provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx, emit: () => {},
        summarize: async () => { summarizerCalls++; return { summary: 'S', usd: 0, tokens: 0 }; }, microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 4 }, contextLimit: WIN });
      return { res, posts, summarizerCalls, start, line };
    };
    const shapes = [
      // [window, the provider's hard limit (0 = it takes anything that fits the window), paste chars, whether the fold line is crossed before the first post]
      [8000, 7000, 29700, true], [8000, 7000, 31050, true], [8000, 7000, 32400, true],      // the proactive fold lands above what the provider takes
      [8000, 4000, 18000, false],                                                           // under the fold line, but over what the provider takes: the overflow recovery
      [32000, 0, 91800, true], [32000, 0, 102600, true]                                     // a big window: the fold has to land under the line, or the next post folds again
    ];
    for (const [WIN, HARD, chars, proactive] of shapes) {
      const tag = WIN + ' window, ' + (HARD ? 'provider takes ' + HARD : 'no hard limit') + ', paste of ' + chars + ' chars';
      const { res, posts, summarizerCalls, start, line } = await run(WIN, HARD || WIN, chars);
      A.eq(start > line, proactive, tag + ': the fixture is ' + (proactive ? 'over' : 'under') + ' the fold line (' + start + ' vs ' + line + ')');
      A.ok(start > (HARD || line), tag + ': and over what the provider takes (' + start + ')');
      A.eq(res.reason, 'done', tag + ': the run finishes (not context_overflow)');
      A.ok(posts[posts.length - 1] <= (HARD || WIN), tag + ': the request the provider took was under its limit (' + posts.join(', ') + ')');
      A.ok(proactive ? posts[0] < line : posts.length === 2, tag + ': ' + (proactive ? 'the fold landed under the fold line, not just under the limit (' + posts[0] + ' vs ' + line + ')' : 'one refusal, then the request that fits'));
      A.ok(posts.length <= 2 && summarizerCalls === 1, tag + ': one fold, at most one refusal (posts ' + posts.length + ', summarizer calls ' + summarizerCalls + ')');
    }
  }

  // ---- 7. THE RUN'S OWN REQUEST: pinned whole while it weighs no more than the verbatim cap or a quarter of the window, folded past that ----
  // A run already working in a long chat (its tool pairs pushed the request into the slice): a request heavier than a quarter of
  // the window would be a weight no fold can remove, the same trap as a pasted turn. Folded, it rides the verbatim section as the
  // 'current task' at the cap one message gets, exactly as before the lane.
  {
    const WIN = 8000;     // threshold 5200, a quarter of the window 2000 tokens, the verbatim cap 1004
    for (const [chars, pinned] of [[1200, true], [6000, true], [7900, true], [8200, false], [12000, false]]) {
      const tag = 'request of ' + chars + ' chars';
      const request = { role: 'user', content: 'Now: ' + ASK + ' ' + 'q'.repeat(chars) };
      const seed = [{ role: 'system', content: 'You are a station agent.' }];
      for (let k = 1; k <= 4; k++) seed.push({ role: 'user', content: 'Request ' + k + ': question number ' + k }, { role: 'assistant', content: 'Reply ' + k + ' ' + 'r'.repeat(1200) });
      seed.push(request);
      for (let k = 1; k <= 4; k++) { seed.push(call('w' + k)); seed.push({ role: 'tool', tool_call_id: 'w' + k, content: 'run result ' + k + ' ' + 'T'.repeat(4000) }); }
      const probe = makeContext({ contextLimit: WIN, compactAt: 0.65, keepTail: 2 });
      A.ok(probe.estimateMessages(seed) > 0.65 * WIN, tag + ': the fixture is over the fold line (' + probe.estimateMessages(seed) + ')');
      const { res, requests, folded } = await oneFold(seed, 2, WIN);
      A.eq(res.reason, 'done', tag + ': the run completes');
      A.ok(folded.length >= 1 && (folded[0].includes(request)) === !pinned, tag + ': the summarizer ' + (pinned ? 'never receives' : 'receives') + ' the request');
      const sent = requests[0];
      if (pinned) A.ok(sent[1] === request && isNote(sent[2]), tag + ': the request is pinned right before the note');
      else {
        A.ok(!sent.includes(request), tag + ': the request is not a message of the prompt');
        A.ok(/\[current task: first \d+ of \d+ chars\]/.test(String((sent.find(isNote) || {}).content)), tag + ': it rides the verbatim section as the current task, clipped and saying so');
      }
      A.eq(count(JSON.stringify(sent), ASK), 1, tag + ': its words ride the request exactly once');
      A.ok(probe.estimateMessages(sent) < probe.estimateMessages(seed), tag + ': and the fold shrank the prompt');
    }
  }

  A.report('fold-head-pin.test');
})().catch(e => { console.error(e); process.exit(1); });
