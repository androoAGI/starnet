/* node test/outcomes.test.js — THE TRACK RECORD (sidecar/outcomes.js): run outcomes finally teach the user model.

   Locks the honesty laws:
     - every number in a line is a LITERAL count of runs inside the 30-day window (never a decayed weight)
     - support before speech: under MIN_SUPPORT a key produces no line and no prior (null, never 0.5)
     - only DECIDED runs classify: done=success, error/max_iters/budget/refusal/empty=failure; cancelled and
       clarifying classify nothing; internal rows are excluded wholesale
     - lane derivation follows the workstream-prefix vocabulary; lane:interactive never rates FAILING
     - successPrior is Laplace-smoothed and absent under support (a caller's default must stay untouched) */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const O = require('../sidecar/outcomes.js');

const T = 1780000000000;
const run = (over) => Object.assign({ runId: 'r', agentId: 'agent', reason: 'done', streamId: 'sess-1', recipeId: '', model: 'm/x', title: '', ts: T - 1000, internal: false }, over);

/* ── 1. classification + exclusions ── */
{
  const rows = [
    run({ reason: 'done' }), run({ reason: 'error' }), run({ reason: 'max_iters' }),
    run({ reason: 'cancelled' }),        // the Commander's own hand — classifies nothing
    run({ reason: 'clarifying' }),       // a question, not an attempt
    run({ reason: 'done', internal: true }),   // harness self-talk — excluded wholesale
    run({ reason: 'done', ts: T - O.WINDOW_MS - 1 })   // outside the window
  ];
  const rec = O.fold(rows, { now: T });
  A.eq(rec.decided, 3, 'exactly the decided in-window non-internal rows count (3 of 7)');
  const lane = rec.keys['lane:interactive'];
  A.eq(lane.n + '/' + lane.ok + '/' + lane.fail, '3/1/2', 'lane tallies are literal counts');
  A.eq(lane.failReasons.error + lane.failReasons.max_iters, 2, 'failure reasons are tallied by name');
}

/* ── 2. lanes from the stream-prefix vocabulary ── */
A.eq(O.laneOf('nightshift-act-3'), 'night shift', 'nightshift streams');
A.eq(O.laneOf('cron-job-1'), 'scheduled', 'cron streams');
A.eq(O.laneOf('workshop-9'), 'workshop', 'workshop streams');
A.eq(O.laneOf('loop-2'), 'loop', 'loop streams');
A.eq(O.laneOf('sess-abc'), 'interactive', 'everything else is the Commander at the console');

/* ── 3. support before speech ── */
{
  const two = O.fold([run({ reason: 'error', streamId: 'cron-1' }), run({ reason: 'error', streamId: 'cron-1' })], { now: T });
  A.eq(O.summary(two).length, 0, 'two data points are an anecdote — no pattern speaks');
  A.eq(O.lines(two).length, 0, '…and no line renders');
  A.eq(O.successPrior(two, 'lane:scheduled'), null, '…and the prior is NULL, never a fabricated number');
}

/* ── 4. proven + failing lines carry literal counts and the top failure ── */
{
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(run({ reason: 'done', recipeId: 'radar', title: 'Stock Radar', ts: T - i * 1000 }));
  rows.push(run({ reason: 'error', recipeId: 'radar', title: 'Stock Radar' }));
  for (let i = 0; i < 4; i++) rows.push(run({ reason: 'error', streamId: 'cron-x', ts: T - i * 500 }));
  rows.push(run({ reason: 'done', streamId: 'cron-x' }));
  const rec = O.fold(rows, { now: T });
  const ls = O.lines(rec);
  const proven = ls.find(l => l.indexOf('Stock Radar') >= 0);
  A.ok(!!proven, 'a supported high-rate recipe earns a line');
  A.ok(proven.indexOf('6 of 7') >= 0, '…whose numbers are the literal window counts (' + proven + ')');
  const failing = ls.find(l => l.indexOf('scheduled runs') >= 0);
  A.ok(!!failing, 'a supported failing lane earns a line');
  A.ok(failing.indexOf('1 of 5') >= 0 && failing.indexOf('error ×4') >= 0,
    '…citing the count AND the named top failure (' + failing + ')');
  A.ok(ls.length <= O.LINE_CAP, 'the lines are capped for prompt real estate');

  // the ranker's read
  A.eq(O.successPrior(rec, 'recipe:radar'), Math.round(((6 + 1) / (7 + 2)) * 1000) / 1000, 'the prior is Laplace-smoothed ok+1/n+2');
  A.ok(O.successPrior(rec, 'lane:scheduled') < 0.4, 'a failing lane reads a low prior');
  A.eq(O.successPrior(rec, 'recipe:nosuch'), null, 'an unknown key is null');
}

/* ── 5. lane:interactive never rates FAILING (a chat failure is usually a conversation, not a work shape) ── */
{
  const rows = [run({ reason: 'error' }), run({ reason: 'error' }), run({ reason: 'error' }), run({ reason: 'error' })];
  const rec = O.fold(rows, { now: T });
  A.eq(O.summary(rec).some(p => p.key === 'lane:interactive'), false, 'four interactive errors produce no failing pattern');
  const done = [run({}), run({}), run({}), run({})].map((r, i) => Object.assign(r, { ts: T - i }));
  A.eq(O.summary(O.fold(done, { now: T })).some(p => p.key === 'lane:interactive' && p.verdict === 'proven'), true,
    '…but a proven interactive record may still speak');
}

/* ── 6. middling rates stay silent — the record only speaks where the signal is strong ── */
{
  const rows = [run({}), run({ reason: 'error' }), run({}), run({ reason: 'error' }), run({})].map((r, i) => Object.assign(r, { streamId: 'cron-m', ts: T - i }));
  A.eq(O.summary(O.fold(rows, { now: T })).length, 0, 'a 60% lane is neither proven nor failing — silence');
}

/* ── 7. hardening ── */
A.eq(O.fold(null, { now: T }).decided, 0, 'null rows fold to an empty record');
A.eq(O.lines(null).length, 0, 'a null record renders nothing');
A.eq(O.successPrior(null, 'x'), null, '…and leans nothing');
{
  const rec = O.fold([run({ model: '(unknown)' })], { now: T });
  A.eq(Object.keys(rec.keys).some(k => k.indexOf('model:') === 0), false, 'an (unknown) model earns no model key');
}

/* ── 8. THE WIRES (behavior where node-loadable, source-locked where the seam is host flow) ── */
{
  // commander-context: the lines ride the weak-evidence fence, labeled TRACK RECORD
  const CC = require('../sidecar/commander-context.js');
  const out = CC.compose({ trackRecord: ['"Stock Radar" (recipe) — finished clean 6 of 7 recent runs', '', 'x'.repeat(500)] });
  A.ok(out.indexOf('<commander_evidence provenance="observed; weak; never override the current request">') >= 0,
    'track-record lines live inside the weak-evidence fence');
  A.ok(out.indexOf('TRACK RECORD: "Stock Radar" (recipe) — finished clean 6 of 7 recent runs') >= 0,
    '…verbatim, labeled TRACK RECORD');
  A.ok(out.indexOf('TRACK RECORD: xxx') >= 0 && out.indexOf('x'.repeat(201)) < 0, 'each line is clipped');
  A.eq(CC.compose({ trackRecord: [] }).indexOf('TRACK RECORD'), -1, 'no record, no section — never an empty header');
  // THE TRUNCATION LAW (consistency sweep, 2026-08-30): on a WARM station the 20-line evidence cap must drop
  // the statistic, never the grounding — every RECENT ACTIVITY line survives a full house; TRACK RECORD yields.
  const warm = CC.compose({
    topics: [1, 2, 3, 4, 5, 6].map(i => ({ label: 'topic ' + i, count: i })),
    threads: [1, 2, 3, 4, 5].map(i => ({ title: 'thread ' + i })),
    worksignal: 'dish-heavy',
    verdicts: { kinds: { seed: { weight: 0.4, positive: 3, negative: 1 } } },
    activity: [1, 2, 3, 4, 5, 6].map(i => ('did the thing ' + i)),
    trackRecord: ['tr one', 'tr two', 'tr three', 'tr four']
  });
  A.eq((warm.match(/RECENT ACTIVITY:/g) || []).length, 6, 'all 6 activity lines survive a full evidence house');
  A.ok((warm.match(/TRACK RECORD:/g) || []).length < 4, '…and it is the TRACK RECORD tail that truncated instead');

  // contextpack: a labeled section for the night shift, NOT in the grounding pool
  const CP = require('../sidecar/contextpack.js');
  const pack = CP.assemble({ trackRecord: ['scheduled runs — only 1 of 5 recent runs finished (top failure: error ×4)'] }, { now: T });
  const sect = pack.sections.find(s => s.label === 'What keeps working vs failing here');
  A.ok(!!sect && sect.lines.length === 1, 'the pack carries the track-record section');
  A.eq(pack.activityLines.length, 0, 'a statistic is context, NEVER grounding-pool evidence a candidate may cite');
}
{
  // host seams (DOM/boot flow — source-locked like the sibling suites' wiring sections)
  const fs = require('fs');
  const path = require('path');
  const idx = readSidecarSource();
  A.ok(/function stationTrackRecord\(\)/.test(idx) && /personalizationStore\.read\(\)\.enabled\) return null/.test(A.fnBody(idx, 'function stationTrackRecord()')),
    'the shared read exists and the personalization PAUSE returns null before any fold');
  A.ok(/const trackRecord = stationTrackRecordLines\(\);/.test(A.fnBody(idx, 'function commanderEvidenceInputs(evidence)')),
    'the evidence composer consumes the shared read (every evidence:true generator now sees the record)');
  // (context-key-redact, 2026-10-28: the pack scrubs with its own default resolver now; `redact` rides only as the
  // self-talk join's matchRedact)
  A.ok(/learn, trackRecord, matchRedact: redact \}, \{ now \}\);/.test(idx),
    'the night-shift context pack consumes the SAME read');
  A.ok(/success: q\.contract && q\.contract\.type === 'attest' \? 0\.55 : \(autoPrior != null \? autoPrior : 0\.8\)/.test(idx),
    'the quest ranker\'s success feature reads the measured autonomous-lane prior, guess only under support');
  A.ok(/trackRecord = \{ decided: rec\.decided, windowMs: rec\.windowMs, patterns: Outcomes\.summary\(rec\), lines: Outcomes\.lines\(rec\) \}/.test(idx),
    'GET /api/insights serves the same record (the fold every prompt cites is inspectable over HTTP)');
}

/* ── the Commander's verdict outranks the harness: a finished run rated `miss` is a failure ── */
{
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(run({ runId: 'radar-' + i, recipeId: 'radar', title: 'Stock Radar', ts: T - i * 1000 }));
  const blind = O.fold(rows, { now: T });
  A.eq(O.summary(blind)[0] && O.summary(blind)[0].verdict, 'proven', 'without verdicts, five finished runs read as proven');
  const verdicts = { 'radar-0': 'miss', 'radar-1': 'miss', 'radar-2': 'miss', 'radar-3': 'miss', 'radar-4': 'great' };
  const rated = O.fold(rows, { now: T, verdicts });
  const k = rated.keys['recipe:radar'];
  A.eq(k.n + '/' + k.ok + '/' + k.fail, '5/1/4', 'four runs the Commander rated missed count as failures');
  A.eq(k.failReasons.rated_missed, 4, 'named as rated_missed');
  const line = O.lines(rated).find(l => l.indexOf('Stock Radar') >= 0);
  A.ok(line && line.indexOf('only 1 of 5 recent runs landed') >= 0 && line.indexOf('rated_missed ×4') >= 0, 'the line says it did not land, and why (' + line + ')');
  A.eq(O.fold([run({ runId: 'x', reason: 'error' })], { now: T, verdicts: { x: 'great' } }).keys['lane:interactive'].ok, 0, 'praise never turns a harness failure into a success');
}

A.report('outcomes track record');
