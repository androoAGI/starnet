/* node test/run-context.compaction.test.js — the per-run <run_context> note survives every fold (lean-prompt 2026-10-12).

   The per-run block (Task Brief, [RUNTIME], quests …) used to close the SYSTEM prompt, which compaction never folds.
   It now rides a fenced system note placed with the run's newest user message (index.js CACHE-STABLE PREFIX) — a
   message a long run DOES fold. The fold must carry it: out of the summarizer's slice, back in right after the
   summary note, exactly once, in every post-fold request. Real runAgentLoop + makeContext(RUN_CONTEXT_DEFAULTS), a
   scripted provider that reads until the context folds, and both fold paths (paid + deterministic fallback). */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runContextNote, isRunContextNote, crewCallFence, isCrewCallNote } = require('../sidecar/providers/provider.js');

const NOTE = runContextNote('<task_brief id="tb_r1" status="active">ORIGINAL REQUEST: read cfg files</task_brief>\n\n[RUNTIME]\nRun id: r1');
const READ_TOOL = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];

function seed() {
  return [
    { role: 'system', content: 'You are an auditor agent.' },
    { role: 'user', content: 'Directive: audit the config files.' },
    { role: 'assistant', content: 'Understood.' },
    { role: 'system', content: NOTE },
    { role: 'user', content: 'Go: read cfg-01..cfg-10 and report each VALUE.' }
  ];
}
function scripted(ctx, n, requests) {
  let turn = 0;
  return { priceOf: () => null, contextLimit: () => ctx.contextLimit, stream: async function* (req) {
    turn++;
    const est = ctx.estimateMessages(req.messages);
    requests.push(req.messages.slice());
    if (turn <= n) {
      yield { type: 'tool_start', index: 0, id: 'c' + turn, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', delta: 'REPORT' }; yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'stop' };
  } };
}
const isSummary = m => m && m.role === 'system' && /^<conversation_summary>/.test(String(m.content));

(async () => {
  for (const mode of ['paid', 'fallback']) {
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const requests = [], slices = [], compacts = [];
    const res = await runAgentLoop({
      messages: seed(), provider: scripted(ctx, 10, requests), cost: makeCostEngine({ priceOf: () => null }), context: ctx, tools: READ_TOOL,
      dispatch: async (c) => ({ ok: true, content: 'cfg ' + c.id + ' VALUE=' + c.id + ' ' + 'v'.repeat(16000) }),
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: mode === 'paid' ? async (older) => { slices.push(older); return { summary: '## Active Task\nAudit.', usd: 0, tokens: 0 }; } : undefined,
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 20 }
    });
    A.eq(res.reason, 'done', mode + ': the run completes');
    A.ok(compacts.length >= 1, mode + ': at least one fold happened (' + compacts.length + ')');
    const firstFolded = requests.findIndex(r => r.some(isSummary));
    A.ok(firstFolded > 0, mode + ': a post-fold request exists');
    for (const [k, r] of requests.slice(firstFolded).entries()) {
      const notes = r.filter(isRunContextNote);
      A.eq(notes.length, 1, mode + ': post-fold request ' + (k + 1) + ' carries the run-context note exactly once');
      A.eq(notes[0] && notes[0].content, NOTE, mode + ': the note is carried verbatim');
      A.eq(r.indexOf(notes[0]), r.findIndex(isSummary) + 1, mode + ': it rides right after the summary note');
    }
    if (mode === 'paid') A.ok(slices.length && slices.every(s => !s.some(isRunContextNote)), 'paid: the summarizer never receives the note to paraphrase');
    A.eq(res.messages.filter(isRunContextNote).length, 1, mode + ': the final transcript holds one note');
  }
  // ONLY THE NOTE WOULD FOLD: a big pinned prefix pushes the prompt over the threshold, and the foldable slice is the
  // note alone (the run's request is the pinned head, the tail keeps the run's latest turn), so the plan's `older` is
  // the note. The pin takes it out of the slice, leaving NOTHING to fold: no summarizer call (a paid call over an
  // empty slice) and no agent.compact claiming a fold that removed nothing. (The head is the run's own request here:
  // a stale first message would be foldable and is no longer pinned — test/fold-head-pin.test.js.)
  {
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const bigNote = runContextNote('<task_brief id="tb_r2" status="active">ORIGINAL REQUEST: ' + 'b'.repeat(20000) + '</task_brief>\n\n[RUNTIME]\nRun id: r2');
    const messages = [
      { role: 'system', content: 'You are an auditor agent. ' + 's'.repeat(56000) },
      { role: 'user', content: 'Go: audit the config files.' },
      { role: 'system', content: bigNote },
      { role: 'assistant', content: 'Starting.' }
    ];
    A.eq(ctx.planCompaction(messages.slice(2)).older.map(m => m.content), [bigNote], 'setup: the plan would fold the note and nothing else');
    const requests = [], slices = [], compacts = [];
    const res = await runAgentLoop({
      messages, provider: scripted(ctx, 0, requests), cost: makeCostEngine({ priceOf: () => null }), context: ctx, tools: READ_TOOL,
      dispatch: async () => ({ ok: true, content: 'unused' }),
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async (older) => { slices.push(older); return { summary: '## Active Task\nAudit.', usd: 0, tokens: 0 }; },
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r2', limits: { maxIters: 5 }
    });
    A.eq(res.reason, 'done', 'note-only: the run completes');
    A.eq(slices.length, 0, 'note-only: the summarizer is never called (nothing to fold)');
    A.eq(compacts.length, 0, 'note-only: no agent.compact is emitted');
    A.ok(requests.length >= 1 && requests.every(r => !r.some(isSummary)), 'note-only: no request carries a summary note');
    A.ok(requests.every(r => r.filter(isRunContextNote).length === 1), 'note-only: the note rides every request, once');
  }
  // THE CREW CALL IS PINNED TOO (review 2026-10-12): it left the run-context note for its own <crew_call> note right
  // after the newest user message (it must trail the Commander's words). In the system prompt no fold ever took it, so
  // no fold may take it now: out of the summarizer's slice, carried after the summary with the run-context note.
  for (const mode of ['paid', 'fallback']) {
    const CREW = crewCallFence('[CREW CALL] The Commander named Ada (agentId researcher) in this request.');
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const requests = [], slices = [], compacts = [];
    const res = await runAgentLoop({
      messages: seed().concat([{ role: 'system', content: CREW }]), provider: scripted(ctx, 10, requests), cost: makeCostEngine({ priceOf: () => null }), context: ctx, tools: READ_TOOL,
      dispatch: async (c) => ({ ok: true, content: 'cfg ' + c.id + ' VALUE=' + c.id + ' ' + 'v'.repeat(16000) }),
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: mode === 'paid' ? async (older) => { slices.push(older); return { summary: '## Active Task\nAudit.', usd: 0, tokens: 0 }; } : undefined,
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r3', limits: { maxIters: 20 }
    });
    A.eq(res.reason, 'done', 'crew ' + mode + ': the run completes');
    A.ok(compacts.length >= 1, 'crew ' + mode + ': at least one fold happened (' + compacts.length + ')');
    const firstFolded = requests.findIndex(r => r.some(isSummary));
    A.ok(firstFolded > 0, 'crew ' + mode + ': a post-fold request exists');
    for (const [k, r] of requests.slice(firstFolded).entries()) {
      const crews = r.filter(isCrewCallNote);
      A.eq(crews.length, 1, 'crew ' + mode + ': post-fold request ' + (k + 1) + ' carries the crew call exactly once');
      A.eq(crews[0] && crews[0].content, CREW, 'crew ' + mode + ': carried verbatim');
      A.ok(r.indexOf(crews[0]) > r.findIndex(isSummary) && r.filter(isRunContextNote).length === 1, 'crew ' + mode + ': after the summary, next to the one run-context note');
    }
    if (mode === 'paid') A.ok(slices.length && slices.every(s => !s.some(isCrewCallNote)), 'crew paid: the summarizer never receives the crew call');
    A.eq(res.messages.filter(isCrewCallNote).length, 1, 'crew ' + mode + ': the final transcript holds one crew call');
  }
  A.report('run-context.compaction');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
