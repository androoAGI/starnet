/* node test/away-briefing.test.js — THE ONE RETURN REPORT (sidecar/away-briefing.js): every kind of unattended
   work folds into ONE briefing composed only from real rows; interactive/internal/child runs never leak in;
   nothing new → no briefing (anti-nag); still-waiting builds are counted, never re-announced as new. */
'use strict';
const A = require('./_assert.js');
const B = require('../sidecar/away-briefing.js');

const SINCE = 1000000, NOW = 2000000;
const run = (o) => Object.assign({ runId: 'r' + Math.random().toString(36).slice(2, 8), agentId: 'agent', reason: 'done', surface: 'autonomous', ts: 1500000, endedAt: 1500000 }, o || {});

// ---- classification ----
A.eq(B.kindOf(run({ streamId: 'cron-abc', cronJobId: 'j1' })), 'routine', 'a cron fire is routine work');
A.eq(B.kindOf(run({ streamId: 'workshop-abc' })), 'build', 'a workshop shift is a build');
A.eq(B.kindOf(run({ streamId: 'nightshift-act-abc' })), 'build', 'a night-shift act is a build');
A.eq(B.kindOf(run({ streamId: 'loop-L1' })), 'loop', 'a LOOP iteration is loop work');
A.eq(B.kindOf(run({ streamId: 'nightshift-abc', internal: true })), null, 'reason-only night-shift planning is never briefed');
A.eq(B.kindOf(run({ streamId: 'cron-abc', surface: 'interactive' })), null, 'the Commander continuing a routine session is attended work');
A.eq(B.kindOf(run({ streamId: 'cron-abc', parentRunId: 'p' })), null, 'delegated children are folded into their parent');
A.eq(B.kindOf(run({ streamId: 'ws-123' })), null, 'an ordinary chat stream is not away work');

// ---- nothing new → no briefing ----
let b = B.compose({ since: SINCE, now: NOW, runs: [], builds: [], drafts: [] });
A.ok(b.empty && b.text === '', 'empty window → empty:true, no text (never nag)');
b = B.compose({ since: SINCE, now: NOW, builds: [{ runId: 'old', title: 'Old thing', builtAt: 500000 }] });
A.ok(b.empty, 'only an OLDER still-waiting build is not news — it never re-briefs by itself');
b = B.compose({ since: SINCE, now: NOW, runs: [run({ streamId: 'cron-x', cronJobId: 'j1', endedAt: 900000 })] });
A.ok(b.empty, 'a run that ended BEFORE the window is not news');

// ---- the full fold ----
const runs = [
  run({ runId: 'c1', streamId: 'cron-c1', cronJobId: 'news', endedAt: 1200000, deliveryText: '✦ Daily AI news\n\n## Top story\n- **OpenAI** ships a thing' }),
  run({ runId: 'c2', streamId: 'cron-c2', cronJobId: 'news', endedAt: 1300000, deliveryText: '# Headlines\nAnthropic released Claude 5' }),
  run({ runId: 'c3', streamId: 'cron-c3', cronJobId: 'inbox', endedAt: 1400000, reason: 'error', failureCode: 'no_key' }),
  run({ runId: 'c4', streamId: 'cron-c4', cronJobId: 'quiet', endedAt: 1450000, deliveryText: '[SILENT]' }),
  run({ runId: 'w1', streamId: 'workshop-w1', endedAt: 1600000, reason: 'max_iters', title: 'Parkour level' }),
  run({ runId: 'l1', streamId: 'loop-L9', endedAt: 1700000, deliveryText: 'Shipped the hero section' }),
  run({ runId: 'i1', streamId: 'ws-1', surface: 'interactive', endedAt: 1700000, title: 'my own chat' }),
  run({ runId: 'n1', streamId: 'nightshift-n1', internal: true, endedAt: 1700000, title: 'propose candidates' })
];
const builds = [
  { runId: 'b-new', agentId: 'agent', title: 'Speedrun timer v2', summary: 'adds split times.', builtAt: 1800000 },
  { runId: 'b-old', agentId: 'agent', title: 'Speedrun timer', builtAt: 400000 }
];
const drafts = [{ title: 'Idea one', at: 1500000 }, { title: 'Stale idea', at: 10 }, { title: 'Speedrun timer v2', at: 1800000 }];
const jobs = [{ id: 'news', name: 'Daily AI news' }, { id: 'inbox', name: 'Inbox sweep' }, { id: 'quiet', name: 'Price watch' }];
b = B.compose({ since: SINCE, now: NOW, tzOffsetMin: 0, runs, builds, drafts, jobs, loops: [{ id: 'L9', name: 'Ship landing page' }], focus: { title: '5.6 test', why: ['you worked on it 4 of the last 7 days'] } });
A.ok(!b.empty, 'real unattended work → a briefing');
A.eq(b.counts.newBuilds, 1, 'one NEW build in the window');
A.eq(b.counts.waitingBuilds, 2, 'both undecided builds are counted as waiting');
A.eq(b.counts.routines, 3, 'three distinct routines grouped by job (not one row per fire)');
A.eq(b.counts.routineRuns, 4, 'four routine fires in total');
// review r8: a build that hit its step limit did not FINISH — it is no failed run: counted apart (counts.unfinished), said in its outcome's words
A.eq(b.counts.failed, 1, 'one failed routine (the build that hit its step limit is no failure)');
A.eq(b.counts.unfinished, 1, 'one unfinished build, counted as itself');
A.eq(b.counts.loops, 1, 'one loop');
A.eq(b.counts.drafts, 1, 'only drafts inside the window count, and a build’s own desk-draft echo is not a second item');
A.ok(b.text.indexOf('my own chat') === -1 && b.text.indexOf('propose candidates') === -1, 'interactive + internal runs never leak into the text');
A.ok(/Waiting on you[\s\S]*Speedrun timer v2[\s\S]*Done/.test(b.text), 'needs-you section comes before done');
A.ok(b.text.indexOf('adds split times. It’s waiting on you') !== -1, 'a summary ending in a period never doubles it');
A.ok(b.text.indexOf('1 earlier build is still waiting') !== -1, 'older undecided builds are a count, not re-announced');
A.ok(b.text.indexOf('“Inbox sweep” failed: no key') !== -1, 'a failed routine says why, in plain words');
A.ok(b.text.indexOf('“Daily AI news” ran 2×. Latest: Headlines') !== -1, 'grouped routine shows fire count + the LATEST real excerpt');
A.ok(b.text.indexOf('“Price watch” ran — nothing new to report.') !== -1, '[SILENT] routine reads as nothing new');
A.ok(b.text.indexOf('Parkour level') !== -1 && b.text.indexOf('reached the step limit') !== -1 && b.text.indexOf('max iters') === -1, 'an unfinished build is surfaced with its reason, in its outcome words (never the raw "max iters")');
A.ok(b.text.indexOf('Loop “Ship landing page”: 1 pass. Latest: Shipped the hero section') !== -1, 'loop progress named from the loop catalogue');
A.ok(b.text.indexOf('Idea one') !== -1 && b.text.indexOf('Stale idea') === -1, 'drafts are windowed');
A.ok(b.text.indexOf('**Next up:** 5.6 test — you worked on it 4 of the last 7 days') !== -1, 'next-up cites its evidence');
A.ok(b.text.indexOf('since Thu 12:16 AM') !== -1, 'since label is local wall-clock (epoch+1000s at tz 0)');
A.eq(b.items.filter(i => i.kind === 'routine').find(i => i.jobId === 'news').latest.open, 'cron-c2', 'routine item opens its latest fire session');
A.eq(b.items.find(i => i.kind === 'build').open, 'workshop-b-new', 'build item opens its own decision session');

// ---- excerpt + context block ----
A.eq(B.excerptOf('## Title\n\n- **bold** thing'), 'Title', 'heading text is a fine first line');
A.eq(B.excerptOf('---\n\n* item `x`'), 'item x', 'rules skipped, markdown stripped');
// A LEAD-IN IS NOT AN OUTCOME (live walk 10-14: the briefing read "Latest: COPY's draft is in the context at the top. Let
// me analyze it now." — the worker's opening line, quoted as if it were what the job produced). Structure decides, not
// words: an opening paragraph that hands over to a rule or heading, or that ends in a colon, introduces the answer.
const STRAT = "COPY's draft is in the context at the top. Let me analyze it now.\n\n---\n\n## EVALUATION OF COPY'S LAUNCH POST\n\n**The verdict:** Pixel-art UI is the weakest angle.";
A.eq(B.excerptOf(STRAT), "EVALUATION OF COPY'S LAUNCH POST", 'an opening paragraph that hands over to a rule is a lead-in, never the outcome');
A.eq(B.excerptOf('I read both drafts.\n\n## Verdict\nShip the second one.'), 'Verdict', 'an opening paragraph that hands over to a heading is a lead-in');
A.eq(B.excerptOf('Here is what I found:\n\n- Two competitors undercut us.'), 'Two competitors undercut us.', 'an opening paragraph ending in a colon introduces the outcome');
A.eq(B.excerptOf('Done. Tagline saved to tagline.md.'), 'Done. Tagline saved to tagline.md.', 'a whole short answer is its own outcome');
A.eq(B.excerptOf('Two competitors undercut us.\n\nBoth cut prices in May.\n\n## Sources\n- a.com'), 'Two competitors undercut us.', 'an answer paragraph followed by more prose keeps its place (a late heading is not a hand-over)');
A.eq(B.excerptOf('Let me check.\n\n---'), 'Let me check.', 'a lead-in with nothing after it is all the text there is');
// …but a colon lead-in is skipped ONLY when prose follows it (review 10-14: the colon rule quoted "python", "| a | b |",
// "> …" and a bare file name). A fence, a table or a lone token after the colon keeps the lead-in, as before.
A.eq(B.excerptOf('Here is the script:\n\n```python\nprint(1)\n```'), 'Here is the script:', 'a code fence after a colon lead-in is not prose: the lead-in stays');
A.eq(B.excerptOf("Here's the tagline:\n\n```markdown\nYour AI agent. Local-first.\n```"), "Here's the tagline:", 'a fenced answer keeps its lead-in (never "markdown")');
A.eq(B.excerptOf('Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Results:', 'a table after a colon lead-in keeps the lead-in (never "| a | b |")');
A.eq(B.excerptOf('I updated three files:\n\n- a.js\n- b.js'), 'I updated three files:', 'a list of bare names is not an outcome sentence: the lead-in stays');
A.eq(B.excerptOf('From the page:\n\n> Ship it before the weekend rush.'), 'Ship it before the weekend rush.', 'a quoted sentence is prose, and its > mark is stripped');
A.eq(B.excerptOf('> A quoted outcome, on its own.'), 'A quoted outcome, on its own.', 'a quote mark never reaches the briefing');
A.eq(B.excerptOf('```python\nprint(1)\n```'), '', 'a reply that is only code has no sentence to quote (never "python")');
A.eq(B.excerptOf('| name | size |\n|---|---|\n| a | 1 |\n\nTwo files are ready.'), 'Two files are ready.', 'table rows are skipped on the way to the first sentence');
{
  const threads = [{ id: 'home', title: 'Write Launch Post' }, { id: 'k9', parentStreamId: 'home', title: 'Evaluate' }];
  const d = B.compose({ since: SINCE, now: NOW, threads, runs: [run({ streamId: 'k9', parentRunId: 'lead', delegatedBy: 'agent', dispatchDelivery: { state: 'final', reason: 'done', text: STRAT } })] });
  A.ok(d.text.indexOf('Let me analyze') === -1 && /Latest: EVALUATION OF COPY'S LAUNCH POST/.test(d.text), 'the briefing names the answer, not its lead-in: ' + d.text);
}

// ---- THE ABSENCE (live walk 10-14): a reload is not an absence, and presence moves the stamp ----
{
  const H = 60000, AWAY = 30 * H, NOW = 1.8e12;   // a real epoch: the window maths must not clamp at zero
  let a = B.absence({ through: NOW - 5 * H, now: NOW, minAwayMs: AWAY, firstWindowMs: 24 * 60 * H });
  A.ok(!a.brief && a.through === NOW, 'the Commander was here 5 minutes ago (a reload, a restart): no briefing, the stamp moves to now');
  a = B.absence({ through: NOW - 2 * 60 * H, now: NOW, minAwayMs: AWAY, firstWindowMs: 24 * 60 * H });
  A.ok(a.brief && a.since === NOW - 2 * 60 * H && a.through === NOW, 'two hours gone → brief exactly the absence');
  a = B.absence({ through: NOW - 5 * H, now: NOW, seen: true });
  A.ok(!a.brief && a.through === NOW, 'a presence stamp moves the stamp and never briefs');
  a = B.absence({ through: NOW + H, now: NOW, seen: true });
  A.eq(a.through, NOW + H, 'the stamp never moves backwards');
  a = B.absence({ through: 0, now: NOW, minAwayMs: AWAY, firstWindowMs: 10 * H });
  A.ok(a.brief && a.since === NOW - 10 * H, 'a first-ever delivery looks back the first window');
  a = B.absence({ through: NOW - 5 * H, now: NOW });
  A.ok(a.brief && a.since === NOW - 5 * H, 'no threshold named → the old contract (brief whatever ended since the stamp)');
  // THE FIRST SESSION (review 10-14): the awakening page has the briefing off but still stamps presence, so a brand-new
  // station's first reload is a reload — never a 24-hour "While you were away" over the session the Commander just watched
  const seen = B.absence({ through: 0, now: NOW - 2 * 60000, seen: true });
  A.ok(!seen.brief && seen.through === NOW - 2 * 60000, 'a first-ever presence stamp sets the stamp and briefs nothing');
  a = B.absence({ through: seen.through, now: NOW, minAwayMs: AWAY, firstWindowMs: 24 * 60 * H });
  A.ok(!a.brief, 'the reload right after it is not an absence');
}

const ctx = B.contextBlock(b);
A.ok(ctx.indexOf('workshop/b-new/') !== -1 && ctx.indexOf('job news') !== -1, 'context block tells the agent where each briefed thing lives');
A.eq(B.contextBlock({ items: [] }), '', 'no items → no context block');

// ---- delegated work (2026-10-09): briefed as the CONVERSATION's work, never as loose child runs ----
{
  const threads = [{ id: 'home', title: 'Launch planning' }, { id: 'k1', parentStreamId: 'home', title: 'Competitor scan' },
    { id: 'k2', parentStreamId: 'home', title: 'Pricing page' }, { id: 'k3', parentStreamId: 'home', title: 'Email' }];
  const d = B.compose({ since: SINCE, now: NOW, threads, runs: [
    run({ streamId: 'k1', parentRunId: 'lead', delegatedBy: 'agent', deliveryText: 'Two competitors undercut us.' }),
    run({ streamId: 'k2', parentRunId: 'lead', delegatedBy: 'agent', endedAt: 1600000, ts: 1600000 }),
    run({ streamId: 'k3', parentRunId: 'lead', delegatedBy: 'agent', reason: 'error', failureCode: 'timeout', endedAt: 1700000, ts: 1700000 }),
    run({ streamId: 'home', parentRunId: 'k1run' }),                                        // the overseer's own review: not a worker
    run({ streamId: 'k1', parentRunId: 'lead', delegatedBy: 'agent', surface: 'interactive' }), // the Commander in that thread
    run({ streamId: 'orphan', parentRunId: 'lead', delegatedBy: 'agent' })                   // a thread this station doesn't know
  ] });
  const g = d.items.filter(i => i.kind === 'delegated');
  A.eq(g.length, 1, 'one row per conversation, not per worker');
  A.eq(g[0].name + '|' + g[0].runs + '|' + g[0].failed + '|' + g[0].open, 'Launch planning|3|1|home', 'counts its workers and opens at the conversation');
  A.eq(d.counts.delegated, 3, 'counted');
  A.ok(/1 delegated job in “Launch planning” failed: timeout/.test(d.text), 'a failed worker is waiting on you, said as failed (review 8.1)');
  A.ok(/“Launch planning”: 2 delegated jobs finished/.test(d.text), 'the finished ones are done');
  A.ok(/conversation "Launch planning" \(home\): 3 delegated job\(s\)/.test(B.contextBlock(d)), 'the reply context says where the threads live');
  A.ok(!B.compose({ since: SINCE, now: NOW, runs: [run({ streamId: 'k1', parentRunId: 'lead', delegatedBy: 'agent' })] }).items.length,
    'without its thread map, a worker run is never briefed loose');
}

// ---- a delegated job is judged by its FINAL delivery, not its execution row (review threads-backend-11) ----
{
  const threads = [{ id: 'home', title: 'Launch planning' }, { id: 'k4', parentStreamId: 'home', title: 'Facts' }, { id: 'k5', parentStreamId: 'home', title: 'Summary' }];
  const d = B.compose({ since: SINCE, now: NOW, threads, runs: [
    // the run ended 'done' but its output failed the result contract: nothing was accepted
    run({ streamId: 'k4', parentRunId: 'lead', delegatedBy: 'agent', deliveryText: '{"facts":[', dispatchDelivery: { state: 'final', reason: 'invalid-result', text: '' } }),
    // the run's raw text needed a repair; the accepted answer is the final delivery's text
    run({ streamId: 'k5', parentRunId: 'lead', delegatedBy: 'agent', deliveryText: 'RAW UNREPAIRED OUTPUT', endedAt: 1600000, ts: 1600000, dispatchDelivery: { state: 'final', reason: 'done', text: 'Webb saw the earliest galaxies.' } }),
    // the internal schema-repair run is harness work, not a second job
    run({ streamId: 'k5', parentRunId: 'k5run', delegatedBy: 'agent', internal: true, endedAt: 1650000, ts: 1650000, deliveryText: 'repair' })
  ] });
  const g = d.items.filter(i => i.kind === 'delegated');
  A.eq(g.length && g[0].runs + '|' + g[0].failed, '2|1', 'two delegated jobs, one of them failed (the repair run is not a job)');
  A.ok(/1 delegated job in “Launch planning” failed/.test(d.text), 'an output that failed validation is waiting on you, not finished');
  A.ok(/“Launch planning”: 1 delegated job finished\. Latest: Webb saw the earliest galaxies\./.test(d.text), 'the excerpt is the accepted answer, not the raw output: ' + d.text);
  const only = B.compose({ since: SINCE, now: NOW, threads, runs: [run({ streamId: 'k4', parentRunId: 'lead', delegatedBy: 'agent', dispatchDelivery: { state: 'final', reason: 'invalid-result', text: '' } })] });
  A.ok(/failed: invalid result/.test(only.text), 'the reason is the delivery\'s reason in plain words: ' + only.text);
  // a delivery that only repeats the run's own reason adds nothing: the run's failure code says more (rate limit)
  const same = B.compose({ since: SINCE, now: NOW, threads, runs: [run({ streamId: 'k4', parentRunId: 'lead', delegatedBy: 'agent', reason: 'error', failureCode: 'rate_limit', dispatchDelivery: { state: 'final', reason: 'error', text: '' } })] });
  A.ok(/failed: rate limit/.test(same.text), 'a delivery that repeats the run reason keeps the run\'s failure code: ' + same.text);
  const pending = B.compose({ since: SINCE, now: NOW, threads, runs: [run({ streamId: 'k5', parentRunId: 'lead', delegatedBy: 'agent', deliveryText: 'Draft facts.', dispatchDelivery: { state: 'pending' } })] });
  A.ok(/1 delegated job finished\. Latest: Draft facts\./.test(pending.text), 'a pending delivery falls back to the execution row');
}

// ---- review 8.1: a delegated worker that ASKED or did not finish is no failed job — counted, briefed and handed to the model apart ----
{
  const threads = [{ id: 'home', title: 'Launch planning' }, { id: 'k6', parentStreamId: 'home', title: 'Copy' }];
  const w = o => run(Object.assign({ streamId: 'k6', parentRunId: 'lead', delegatedBy: 'agent' }, o));
  const d = B.compose({ since: SINCE, now: NOW, threads, runs: [
    w({ reason: 'clarifying', outcome: 'asked', endedAt: 1500000, ts: 1500000 }),
    w({ reason: 'done', finishReason: 'length', outcome: 'cut_short', endedAt: 1600000, ts: 1600000 }),
    w({ dispatchDelivery: { state: 'final', reason: 'budget', text: '' }, endedAt: 1650000, ts: 1650000 }),
    w({ reason: 'error', failureCode: 'rate_limit', endedAt: 1700000, ts: 1700000 })
  ] });
  A.eq(d.counts.failed + '|' + d.counts.unfinished, '1|3', 'counts.failed is the failed worker alone; the question, the cut reply and the spend cap are counts.unfinished');
  A.ok(/1 delegated job in “Launch planning” failed: rate limit\./.test(d.text) && /2 delegated jobs in “Launch planning” did not finish: hit a spending limit\./.test(d.text)
    && /1 delegated job in “Launch planning” asked you a question/.test(d.text) && !/3 delegated jobs[^\n]*didn’t finish/.test(d.text),
    'Waiting on you says the failure, the unfinished ones and the question each as itself: ' + d.text);
  const ctx = B.contextBlock(d);
  A.ok(/4 delegated job\(s\), 1 failed, 2 did not finish, 1 asked a question;/.test(ctx) && !/4 failed|3 failed/.test(ctx), 'the reply context tells the model 1 failed, never 4: ' + ctx);
}

A.report('away-briefing');
