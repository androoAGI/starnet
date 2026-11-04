/* node test/preflight.first-call-fold.test.js — Step 2 wave 2, audit F1: a history already over the window folds
   BEFORE the first provider request.

   The bug (audit probe 09-22): maybeCompact gated on the previous turn's usage, and a run has none before its first
   call, so a resumed/seeded conversation at 150% of a 200k window was sent as-is — 0 fold attempts, the provider
   left to reject it. Now the decision uses the usage anchor, which before any reading is the full local ruler
   (messages + tool schemas). Driven through the REAL runAgentLoop + makeContext with the production context policy
   (RUN_CONTEXT_DEFAULTS, exactly what index.js runOnce builds). Deterministic, no network. */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { projectRoles } = require('../sidecar/providers/provider.js');

const WINDOW = 200000;
function seeded() {
  const messages = [{ role: 'system', content: 'You are a station agent.' }];
  for (let i = 0; i < 120; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i + ' ' + 'z'.repeat(10000) });
  messages.push({ role: 'user', content: 'new question: what did turn 118 say?' });
  return messages;
}

(async () => {
  // ---- 1. 150% of the window at run start -> the fold happens before request #1, and request #1 fits ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: WINDOW }, RUN_CONTEXT_DEFAULTS));
    const messages = seeded();
    const startTokens = ctx.estimateMessages(messages);
    A.ok(startTokens > 1.4 * WINDOW, 'the seeded history really is ~150% of the window (' + startTokens + ' est. tokens)');
    const log = [];   // ordered: summarizer calls and provider requests
    const sent = [];
    const provider = {
      priceOf: () => null, contextLimit: () => WINDOW,
      stream: async function* (req) {
        const est = ctx.estimateMessages(req.messages);
        log.push('request'); sent.push({ est, messages: req.messages.slice() });
        yield { type: 'text', delta: 'answer' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 5, total_tokens: est + 5 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    const compacts = [];
    const res = await runAgentLoop({
      messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      emit: (n, p) => { if (n === 'agent.compact') { compacts.push(p); log.push('compact:' + p.reason); } },
      summarize: async (older) => { log.push('summarize'); return { summary: '## Completed\n- ' + older.length + ' earlier turns folded', usd: 0, tokens: 0 }; },
      model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 5 }, contextLimit: WINDOW
    });
    A.eq(res.reason, 'done', 'the run completes');
    A.ok(sent.length >= 1, 'a request was made');
    const firstReq = log.indexOf('request');
    const firstFold = log.findIndex(e => e === 'summarize' || /^compact:/.test(e));
    A.ok(firstFold >= 0 && firstFold < firstReq, 'a fold happened BEFORE the first provider request (log: ' + log.join(' > ') + ')');
    A.ok(compacts.length >= 1 && compacts[0].beforeTokens > WINDOW, 'the fold measured the over-window prompt (' + (compacts[0] && compacts[0].beforeTokens) + ')');
    A.ok(sent[0].est < 0.65 * WINDOW, 'the first request is under the compaction threshold (' + sent[0].est + ' est. tokens vs ' + (0.65 * WINDOW) + ')');
    A.ok(sent[0].messages.some(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content))), 'the first request carries the summary note');
    A.eq(sent[0].messages[sent[0].messages.length - 1].content, 'new question: what did turn 118 say?', 'the newest user question is sent verbatim, last');
    // the chat's FIRST message is turn 1 of a 120-turn conversation, not this run's task: it is no longer pinned at the head
    // (only the run's request, or a user turn light enough to carry whole that a cut splits, is pinned there) — it folded, and
    // its words ride the note once. Every turn of THIS chat is a 10k-character paste, none light enough to pin (loop.js
    // openOnUser: a pin the fold cannot remove must not outweigh what the verbatim section would carry), so the loop's prompt
    // opens on the note and the tail's first reply and the WIRE opens the request on a user turn (providers/provider.js
    // boundaryTurns) on both role policies
    const head = sent[0].messages.find(m => m.role !== 'system');
    for (const policy of ['chat', 'native']) {
      const first = projectRoles(sent[0].messages, policy).find(m => m.role !== 'system');
      A.eq(first && first.role, 'user', 'the request the wire builds still opens on a user turn (' + policy + ' roles)');
    }
    A.ok(String(head.content).indexOf('turn 0 ') !== 0, 'the stale first message is not pinned at the head');
    const folded = sent[0].messages.find(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));
    A.eq(String(folded.content).split('turn 0 ').length - 1, 1, 'its words ride the summary note\'s verbatim user section exactly once');
  }

  // ---- 2. a history UNDER the threshold is sent untouched (the preflight never folds without need) ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: WINDOW }, RUN_CONTEXT_DEFAULTS));
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello ' + 'q'.repeat(4000) }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'go' }];
    let summarized = 0, compacts = 0, first = null;
    const provider = { priceOf: () => null, contextLimit: () => WINDOW, stream: async function* (req) { if (!first) first = req.messages.slice(); yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; } };
    const res = await runAgentLoop({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      emit: (n) => { if (n === 'agent.compact') compacts++; }, summarize: async () => { summarized++; return 'S'; }, model: 'm', agentId: 'a', runId: 'r' });
    A.eq(res.reason, 'done', 'a small run completes');
    A.eq(summarized + compacts, 0, 'no fold and no summarizer call under the threshold');
    A.eq(first.length, 4, 'the first request carries the history unchanged');
  }

  // ---- 3. the ruler counts the TOOL SCHEMAS the provider will count: a history under the threshold by messages
  //         alone but over it with a large advertised tool list folds before request #1 ----
  {
    const WIN = 20000;
    const ctx = makeContext(Object.assign({ contextLimit: WIN }, RUN_CONTEXT_DEFAULTS));
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'directive' }];
    for (let i = 0; i < 12; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i + ' ' + 'w'.repeat(3000) });
    messages.push({ role: 'user', content: 'now' });
    const tools = [];
    for (let i = 0; i < 30; i++) tools.push({ type: 'function', function: { name: 'tool_' + i, description: 'd'.repeat(600), parameters: { type: 'object', properties: {} } } });
    const msgTokens = ctx.estimateMessages(messages), toolTokens = ctx.estimateTokens(JSON.stringify(tools));
    A.ok(msgTokens < 0.65 * WIN && msgTokens + toolTokens > 0.65 * WIN, 'fixture: messages alone under the threshold (' + msgTokens + '), messages + schemas over it (' + (msgTokens + toolTokens) + ')');
    const log = [];
    const provider = { priceOf: () => null, contextLimit: () => WIN, stream: async function* () { log.push('request'); yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; } };
    await runAgentLoop({ messages, provider, tools, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      emit: (n, p) => { if (n === 'agent.compact') log.push('compact:' + p.reason); }, summarize: async () => { log.push('summarize'); return 'S'; }, model: 'm', agentId: 'a', runId: 'r' });
    A.ok(log.indexOf('summarize') >= 0 && log.indexOf('summarize') < log.indexOf('request'), 'the schema-inclusive ruler folded before the first request (' + log.join(' > ') + ')');
  }

  A.report('preflight.first-call-fold.test');
})().catch(e => { console.error(e); process.exit(1); });
