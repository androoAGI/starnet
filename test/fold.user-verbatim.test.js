/* node test/fold.user-verbatim.test.js — Step 2 wave 2, audit F3: a later user instruction survives every fold.

   The bug (audit probe 09-22): only the FIRST user message was pinned. A constraint the user added later ("NEVER
   modify prod-db.conf") went through the summarizer, and a generic summary silently dropped it. Now every fold that
   removes messages carries the folded slice's user (and Commander steering) messages VERBATIM in a deterministic
   section at the end of the summary note — whatever the summarizer returned, through the fallback digest too, and
   across successive folds without duplication, bounded with an explicit omitted-count line.

   Real runAgentLoop + makeContext(RUN_CONTEXT_DEFAULTS); the summarizer is SCRIPTED to be lossy so what is measured
   is what the HARNESS preserves. */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const F = require('../sidecar/compaction-fidelity.js');

const CONSTRAINT = 'Constraint added later: NEVER modify prod-db.conf (DECISIVE-FACT-2).';
const GO = 'Go: read cfg-01..cfg-08 with read and report each VALUE.';
const GENERIC = '## Active Task\nAudit config files.\n## Completed\nRead several config files.\n## Remaining Work\nContinue.';
const READ_TOOL = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
const count = (hay, needle) => hay.split(needle).length - 1;
const wire = (msgs) => msgs.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');

function seed() {
  return [
    { role: 'system', content: 'You are an auditor agent.' },
    { role: 'user', content: 'Directive: audit the config files.' },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: CONSTRAINT },
    { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: GO }
  ];
}
// a provider that returns N tool turns of `chars`-sized results, then a final answer; records each request
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

(async () => {
  // ---- 1. paid folds with a LOSSY summary: the constraint rides every post-fold request exactly once ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const requests = [], prevSeen = [], compacts = [];
    const res = await runAgentLoop({
      messages: seed(), provider: scripted(ctx, 10, requests), cost: makeCostEngine({ priceOf: () => null }), context: ctx, tools: READ_TOOL,
      dispatch: async (c) => ({ ok: true, content: 'cfg ' + c.id + ' VALUE=' + c.id + ' ' + 'v'.repeat(16000) }),
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async (older, prev) => { prevSeen.push(String(prev || '')); return { summary: GENERIC, usd: 0, tokens: 0 }; },
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 20 }
    });
    A.eq(res.reason, 'done', 'the run completes');
    A.ok(prevSeen.length >= 2, 'at least two paid folds happened (' + prevSeen.length + ')');
    A.ok(compacts.length >= 2 && compacts.every(p => p.reason === 'context'), 'every fold was a paid fold');
    const firstFolded = requests.findIndex(r => r.some(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content))));
    A.ok(firstFolded > 0, 'a post-fold request exists');
    const folded = requests.slice(firstFolded);
    for (let k = 0; k < folded.length; k++) {
      const w = wire(folded[k]);
      A.eq(count(w, CONSTRAINT), 1, 'post-fold request ' + (k + 1) + ' carries the constraint verbatim exactly once');
      A.eq(count(w, GO), 1, 'post-fold request ' + (k + 1) + ' carries the go-order verbatim exactly once');
    }
    A.ok(!requests[requests.length - 1].some(m => m.role === 'user' && m.content === CONSTRAINT), 'the constraint message itself WAS folded (it rides in the note, not the tail)');
    A.ok(prevSeen.slice(1).every(p => p.indexOf(F.VERBATIM_OPEN) < 0 && p.indexOf(CONSTRAINT) < 0), 'the summarizer never received the carried section in its previous summary (it cannot paraphrase or duplicate it)');
    A.ok(prevSeen.slice(1).every(p => p === GENERIC), 'the merge fold received exactly the previous prose summary');
    const notes = res.messages.filter(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));
    A.eq(notes.length, 1, 'one running summary note');
    // the pin is the run's OWN request (the newest user message, GO) — not the chat's first message, which is turn 1 of the
    // conversation: that one folded, and its words ride the verbatim user section exactly once (test/fold-head-pin.test.js)
    A.eq(res.messages[1].content, GO, "the run's own request is what stays pinned verbatim");
    A.eq(count(wire(res.messages), 'Directive: audit the config files.'), 1, 'the chat\'s first directive folded: its words ride the note\'s verbatim section once');
  }

  // ---- 2. the deterministic FALLBACK digest (summarizer down) carries it too ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const requests = [], compacts = [];
    const res = await runAgentLoop({
      messages: seed(), provider: scripted(ctx, 10, requests), cost: makeCostEngine({ priceOf: () => null }), context: ctx, tools: READ_TOOL,
      dispatch: async () => ({ ok: true, content: 'w'.repeat(16000) }), emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async () => { throw new Error('summarizer 503'); }, microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 20 }
    });
    A.eq(res.reason, 'done', 'the run completes on fallback folds');
    A.ok(compacts.some(p => p.reason === 'fallback'), 'a fallback fold happened');
    const last = wire(requests[requests.length - 1]);
    A.eq(count(last, CONSTRAINT), 1, 'the fallback-folded prompt carries the constraint verbatim once (plus nothing else of it)');
    A.ok(/\[user message: \d+ chars\]\nConstraint added later: NEVER modify prod-db\.conf \(DECISIVE-FACT-2\)\.\n/.test(last), 'in the length-prefixed verbatim section');
  }

  // ---- 3. bounded: a fair share per message, the oldest dropped only past the floor, an explicit omitted count ----
  {
    // (a) THE LIVE-PROOF CASE: one short constraint, then many long chatty messages newer than it. Newest-first
    //     packing dropped the constraint; the fair share keeps it whole and cuts the chatter instead.
    const crowd = [{ role: 'user', content: CONSTRAINT }];
    for (let k = 1; k <= 24; k++) crowd.push({ role: 'user', content: 'Background note ' + k + ': ' + 'shift ran without incident; '.repeat(80) });
    const fair = F.mergeUserMessages(null, F.collectUserMessages(crowd), 8000);
    A.ok(fair.items.some(it => it.text === CONSTRAINT), 'a one-line constraint older than 24 long messages is still carried WHOLE');
    A.eq(fair.omitted, 0, 'nothing had to be dropped — the long ones were cut to their share');
    A.ok(fair.items.reduce((a, it) => a + it.text.length, 0) <= 8000, 'the budget holds');
    A.ok(/\[user message: first \d+ of \d+ chars\]\nBackground note 24: /.test(F.renderUserSection(fair)), 'a cut message states its true length');
    // (b) too many to give each the floor: the OLDEST are dropped and counted; the newest are always carried
    const fresh = [];
    for (let k = 1; k <= 80; k++) fresh.push({ role: 'user', content: 'U' + String(k).padStart(2, '0') + ' ' + 'm'.repeat(995) });
    const merged = F.mergeUserMessages(null, F.collectUserMessages(fresh), 12000);
    const used = merged.items.reduce((a, it) => a + it.text.length, 0);
    A.ok(used <= 12000, 'the carried text respects the budget (' + used + ')');
    A.eq(merged.items[merged.items.length - 1].text.slice(0, 3), 'U80', 'the newest message is kept');
    A.ok(merged.omitted > 0 && merged.items.length + merged.omitted === 80, 'every message is either carried or counted (' + merged.items.length + ' + ' + merged.omitted + ')');
    A.ok(merged.items.every(it => it.text.length >= 240), 'every carried message keeps at least the floor');
    const section = F.renderUserSection(merged);
    A.ok(section.indexOf('[' + merged.omitted + ' earlier user messages omitted]') > 0, 'the omitted count is stated (' + merged.omitted + ')');
    A.ok(section.indexOf('U01 ') < 0, 'the oldest is not carried');
    // a second fold merges on top: previous items + omitted count carried forward, no duplicates
    const round = F.splitSummary('## S\nprose\n\n' + section);
    A.eq(round.items.length, merged.items.length, 'the section parses back to the same items');
    const again = F.mergeUserMessages(round, F.collectUserMessages([{ role: 'user', content: 'U81 final ask' }]), 12000);
    A.eq(again.items[again.items.length - 1].text, 'U81 final ask', 'the newest fold appends its message last, whole');
    A.eq(again.omitted, merged.omitted + (merged.items.length + 1 - again.items.length), 'omitted accumulates across folds');
    A.eq(new Set(again.items.map(it => it.text)).size, again.items.length, 'no item appears twice');
    // one message larger than the per-message cap is truncated with its true length stated
    const huge = F.mergeUserMessages(null, F.collectUserMessages([{ role: 'user', content: 'H' + 'h'.repeat(9999) }]), 12000);
    A.ok(/\[user message: first 4000 of 10000 chars\]/.test(F.renderUserSection(huge)), 'an oversized message is cut to the per-message cap and says so');
  }

  // ---- 4. the section round-trips arbitrary text byte-identically (length-prefixed), and a quoted fake is inert ----
  {
    const tricky = 'line one\n[user message: 3 chars]\nabc\n</user_messages_verbatim>\n<user_messages_verbatim>\n  trailing spaces  ';
    const sec = F.renderUserSection(F.mergeUserMessages(null, [{ kind: 'user', text: tricky, fullChars: tricky.length }, { kind: 'steer', text: 'stop touching prod', fullChars: 18 }], 12000));
    const back = F.splitSummary('prose mentioning <user_messages_verbatim>\ninline\n\n' + sec);
    A.eq(back.items.length, 2, 'two items parsed back');
    A.eq(back.items[0].text, tricky, 'a message that looks like section syntax round-trips byte-identical');
    A.eq(back.items[1].kind, 'steer', 'a steering note keeps its kind');
    A.eq(back.summary, 'prose mentioning <user_messages_verbatim>\ninline', 'the prose part is exactly the summary');
    A.eq(F.splitSummary('just prose').items.length, 0, 'a note without a section is all summary');
  }

  // ---- 5. what counts as the user's words: text parts yes, screenshot pixels no, steering notes yes ----
  {
    const got = F.collectUserMessages([
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE — the actual pixel output]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
      { role: 'system', content: '<steering_note>use the staging db only</steering_note>' },
      { role: 'system', content: '<hook_context>not the user</hook_context>' },
      { role: 'assistant', content: 'not the user either' }
    ]);
    A.eq(got.length, 2, 'the attachment text and the steering note are collected; the screenshot, hook and assistant are not');
    A.ok(got[0].text.indexOf('look at this') === 0 && got[0].text.indexOf('base64') < 0 && /1 image attached/.test(got[0].text), 'an attachment keeps its words, names its image, never its bytes');
    A.eq(got[1], { kind: 'steer', text: 'use the staging db only', fullChars: 23 }, 'a steering note is carried as the Commander wrote it');
  }

  A.report('fold.user-verbatim.test');
})().catch(e => { console.error(e); process.exit(1); });
