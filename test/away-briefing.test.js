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
const drafts = [{ title: 'Idea one', at: 1500000 }, { title: 'Stale idea', at: 10 }];
const jobs = [{ id: 'news', name: 'Daily AI news' }, { id: 'inbox', name: 'Inbox sweep' }, { id: 'quiet', name: 'Price watch' }];
b = B.compose({ since: SINCE, now: NOW, tzOffsetMin: 0, runs, builds, drafts, jobs, loops: [{ id: 'L9', name: 'Ship landing page' }], focus: { title: '5.6 test', why: ['you worked on it 4 of the last 7 days'] } });
A.ok(!b.empty, 'real unattended work → a briefing');
A.eq(b.counts.newBuilds, 1, 'one NEW build in the window');
A.eq(b.counts.waitingBuilds, 2, 'both undecided builds are counted as waiting');
A.eq(b.counts.routines, 3, 'three distinct routines grouped by job (not one row per fire)');
A.eq(b.counts.routineRuns, 4, 'four routine fires in total');
A.eq(b.counts.failed, 2, 'one failed routine + one unfinished build');
A.eq(b.counts.loops, 1, 'one loop');
A.eq(b.counts.drafts, 1, 'only drafts inside the window count');
A.ok(b.text.indexOf('my own chat') === -1 && b.text.indexOf('propose candidates') === -1, 'interactive + internal runs never leak into the text');
A.ok(/Waiting on you[\s\S]*Speedrun timer v2[\s\S]*Done/.test(b.text), 'needs-you section comes before done');
A.ok(b.text.indexOf('adds split times. It’s waiting on you') !== -1, 'a summary ending in a period never doubles it');
A.ok(b.text.indexOf('1 earlier build is still waiting') !== -1, 'older undecided builds are a count, not re-announced');
A.ok(b.text.indexOf('“Inbox sweep” failed: no key') !== -1, 'a failed routine says why, in plain words');
A.ok(b.text.indexOf('“Daily AI news” ran 2×. Latest: Headlines') !== -1, 'grouped routine shows fire count + the LATEST real excerpt');
A.ok(b.text.indexOf('“Price watch” ran — nothing new to report.') !== -1, '[SILENT] routine reads as nothing new');
A.ok(b.text.indexOf('Parkour level') !== -1 && b.text.indexOf('max iters') !== -1, 'an unfinished build is surfaced with its reason');
A.ok(b.text.indexOf('Loop “Ship landing page”: 1 pass. Latest: Shipped the hero section') !== -1, 'loop progress named from the loop catalogue');
A.ok(b.text.indexOf('Idea one') !== -1 && b.text.indexOf('Stale idea') === -1, 'drafts are windowed');
A.ok(b.text.indexOf('**Next up:** 5.6 test — you worked on it 4 of the last 7 days') !== -1, 'next-up cites its evidence');
A.ok(b.text.indexOf('since Thu 12:16 AM') !== -1, 'since label is local wall-clock (epoch+1000s at tz 0)');
A.eq(b.items.filter(i => i.kind === 'routine').find(i => i.jobId === 'news').latest.open, 'cron-c2', 'routine item opens its latest fire session');
A.eq(b.items.find(i => i.kind === 'build').open, 'workshop-b-new', 'build item opens its own decision session');

// ---- excerpt + context block ----
A.eq(B.excerptOf('## Title\n\n- **bold** thing'), 'Title', 'heading text is a fine first line');
A.eq(B.excerptOf('---\n\n* item `x`'), 'item x', 'rules skipped, markdown stripped');
const ctx = B.contextBlock(b);
A.ok(ctx.indexOf('workshop/b-new/') !== -1 && ctx.indexOf('job news') !== -1, 'context block tells the agent where each briefed thing lives');
A.eq(B.contextBlock({ items: [] }), '', 'no items → no context block');

A.report('away-briefing');
