/* node test/run-view.lint.test.js - A RUN'S WORDS REACH A MODEL OR A RESPONSE ONLY THROUGH runView (turn identity commit 11, A2-REB-14).

   A run record carries its title, its error line and a delivery preview: words of the session the run ran in. The session ledger
   forgets a deleted session's runs (and, since commit 11, the runs that QUOTE one), but only if every reader asks. runView(name, r)
   (sidecar/index.js, ForgetRegistry.viewRun) is the one ask. This lint reads the whole sidecar as text and requires that every
   runStore.list / .all / .latest call is accounted for exactly once:

     TAGGED   the call sits inside a runView('<key>', ...) of the table below (the statement itself holds the tag, or `follow`
              names the later statement of the same function that applies it). A title, a preview or a response reaches a reader.
     ALLOWED  the call reads ids, state, counts or timestamps for a purpose that can never put a deleted session's words in front
              of a model, said in `reason`. The census- and roundtrip-pinned readers are here (outcome-family.census,
              outcome-roundtrip.table slice them with only runStore in scope).

   Both lists are tables of exact source text: a needle that no longer matches is a failure (a moved or deleted site must be
   re-reviewed, not silently dropped), and so is a runStore call no needle covers (a NEW reader must choose). The checker runs on
   fixtures too, so a lint that passes everything cannot pass this file.

   Site 40 of the design's table (conversationTranscript's readRun) no longer exists: the transcript reads through
   transcriptStore.view('display'), whose rows the store's own predicate filters, so there is no runStore reader left to tag. */
'use strict';
const A = require('./_assert.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

const IDX = 'sidecar/index.js';
// key -> the sixteen tagged sites. `anchor` is exact source text containing the runStore call; it must hold the tag itself, unless
// `follow` is given: then the tag must appear in `follow` within 1500 characters after the anchor.
const TAGGED = [
  { key: 'nightfocus', anchor: "runTitles = (runStore.list(null, { limit: 60 }) || []).filter(r => r && !contextpack.isInternalStream(r.streamId) && runView('nightfocus', r))" },
  { key: 'nightshift', anchor: "return (runStore.list(null, { limit: 60 }) || []).filter(r => r && runView('nightshift', r) && (r.internal ||" },
  { key: 'outcomes', anchor: "Outcomes.fold(runStore.list(null, { limit: 400 }).filter(r => runView('outcomes', r)), {" },
  { key: 'evidence', anchor: "ev.runs = runStore.all().filter(r => runView('evidence', r));" },
  { key: 'remote', anchor: "runHistory: (n) => (runStore.list(null, { limit: n }) || []).filter(r => runView('remote', r))," },
  { key: 'budget', anchor: "const row = runView('budget', runStore.latest(r.runId));" },
  { key: 'deliverables', anchor: "for (const run of runStore.list(null, { limit: 1000 }).filter(r => typeof runView !== 'function' || runView('deliverables', r))) {" },
  { key: 'orchestration', anchor: "runRecord: (id) => runView('orchestration', runStore.latest(id))," },
  { key: 'briefing', anchor: "runs = (runStore.list(null, { limit: 500, since: Math.max(0, since - 1) }) || []).filter(r => runView('briefing', r))" },
  { key: 'rating', anchor: "const allRows = runStore.all().filter(r => runView('rating', r));" },
  { key: 'feedback', anchor: "const lead = rating ? runView('feedback', runStore.all().find(row => row && row.runId === runId)) : null;" },
  { key: 'keepStyle', anchor: "const lead = runView('keepStyle', runStore.all().find(r => r && r.runId === runId));" },
  { key: 'runs', anchor: "const allRows = runStore.all().filter(r => runView('runs', r));" },
  { key: 'runs', anchor: "const page = runStore.list(agent === '*' ? null : agent, { limit: limit + 1, since, through: snapshotAt, beforeRunId });", follow: "page.slice(0, limit).filter(r => runView('runs', r))" },
  { key: 'lineResume', anchor: "inflight: lineResumeInflight, runRow: runId => runView('lineResume', runStore.latest(runId))," },
  { key: 'insights', anchor: "const rows = agent ? runStore.list(agent, { limit: 1000 }) : runStore.all();", follow: "Outcomes.fold(rows.filter(r => runView('insights', r))," }
];

const ALLOWED = [
  { file: IDX, anchor: "runOf: id => runStore.latest(id), hash: text =>", reason: 'the transcript store\'s run lookup classifies rows (directive kind, internal flags) and proves a delivery hash; the rows themselves are filtered by the store\'s own predicate, and a hidden record would reclassify a visible row' },
  { file: IDX, anchor: "const rec = runStore.latest(id);\n    return !!rec && judge(rec);", reason: 'this IS the quote predicate: it reads the record\'s own quote stamp' },
  { file: IDX, anchor: "const rec = runStore.latest(id);\n  return !!rec && ForgetRegistry.viewRun(rec, runViewCtx) === null;", reason: 'this IS the registry\'s forgotten-run test (admit asks it): the run-view filter itself, applied to the record' },
  { file: IDX, anchor: "const rec = runStore.latest(String(runId));\n  if (!rec) return false;", reason: 'this IS the fresh forgotten-run test (runForgottenFresh): it reads the stream id, time and quote stamp and returns a boolean, no words leave it' },
  { file: IDX, anchor: "const rec = runStore.latest(String(workerRunId));", reason: 'the relay reads which sessions a worker read (ids and times), to latch them on its lead' },
  { file: IDX, anchor: "deletedScope(todo, runStore.all())", reason: 'the purge input must read every run, forgotten ones included' },
  { file: IDX, anchor: "outcomeOf: runId => { const row = runStore.latest(runId);", reason: 'a hop\'s outcome only (ChannelHistory admission)' },
  { file: IDX, anchor: "const proof = runStore.all().find(r => r.runId === review.reviewRunId);", reason: 'outcome only' },
  { file: IDX, anchor: "const proof = runStore.all().find(r => r.runId === runId);", reason: 'outcome only' },
  { file: IDX, anchor: "runsFor: streamId => runStore.list(null, { streamId, limit: 200 })", reason: 'shipment receipts: ids and state, no title' },
  { file: IDX, anchor: "cleanJob: (k) => !!(k && k.streamId && k.entryRunId) && !!cleanJobRows(runStore.list(", reason: 'clean-job state' },
  { file: IDX, anchor: "runRow: runId => runStore.latest(runId),", reason: 'the step test reads spend (usd, spendUnknown) only' },
  { file: IDX, anchor: "runRow: (runId) => runStore.latest(runId)", reason: 'the step test reads spend (usd, spendUnknown) only' },
  { file: IDX, anchor: "const rows = (runStore.list(null, { streamId: streamId, limit: 200 }) || [])   // THIS sample's rows", reason: 'the job\'s own stage rows, read at job end for its receipt, accounting and shipments (the census-matched .map literal stays verbatim)' },
  { file: IDX, anchor: "runsFor: (streamId) => (runStore.list(null, { streamId: streamId, limit: 200 }) || []).filter(r => r && String(r.streamId || '') === streamId)", count: 2, reason: 'state-only projection of the trigger and SEND TO runners; outcome-family.census slices it with only runStore in scope' },
  { file: IDX, anchor: "rows: runStore.list(null, { limit: 1000 }) || [], lines, since,", reason: 'line statistics, no title' },
  { file: IDX, anchor: "makeAffinityIndex(runStore.all(), {", reason: 'agent-pair counts' },
  { file: IDX, anchor: "const rows = runStore.all();\n    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {", reason: 'routine history: ids, times, outcome, usd and an error line, no title; outcome-roundtrip.table slices it with only cronStore, cronJobs, runStore in scope' },
  { file: IDX, anchor: "const provenance = makeProvenanceIndex(runStore.all(), {", reason: 'root and agent ids for the rows the deliverables reader admitted' },
  { file: IDX, anchor: "const row = runStore.list(null, { limit: 1000 }).find(r => String(r.runId) === String(rid));", reason: 'a timestamp only' },
  { file: IDX, anchor: "body && body.connectorContinuationOf ? runStore.all() : []", reason: 'continuation scope (ids and agents)' },
  { file: IDX, anchor: "const was = runStore.latest(retryOf);", reason: 'recipeId only' },
  { file: IDX, anchor: "record = runStore.latest(runId); } catch (e) { failNote('run.steer.status.record', e);", reason: 'note ids and flags of the steer status' },
  { file: IDX, anchor: "const recent = (() => { try { return runStore.list(null, { limit: 1 })[0] || null;", reason: 'diagnostics: provider and model of the last run (the census-sliced lastRun literal reads runId, status and ts)' },
  { file: IDX, anchor: "const rows = runStore.list(null, { limit: 500 }).filter(r => r && r.recipeId", reason: 'recipe drift counts, no title' },
  { file: IDX, anchor: "const existing = runStore.latest(r.runId);", reason: 'recovery state' },
  { file: IDX, anchor: "for (const row of runStore.all()) {", reason: 'recovery state' },
  { file: IDX, anchor: "const settled = runStore.latest(sourceRunId);", reason: 'recovery state' },
  { file: IDX, anchor: "try { row = runStore.latest(id); } catch (e) { failNote('transcript.run-since', e); }", reason: 'a timestamp bound' },
  { file: IDX, anchor: "const r = b && b.runId ? runStore.latest(b.runId) : null;", reason: 'a boolean only (is it a hand-off)' },
  { file: 'sidecar/routine-delivery.js', anchor: "runs = runStore.list(null, { streamId: 'cron-' + rec.runId, limit: 50 }) || [];", reason: 'this fire\'s artifact ledger, no title' },
  { file: 'sidecar/routine-delivery.js', anchor: "runs = runStore.list(null, { streamId: 'cron-' + result.runId, limit: 50 }) || [];", reason: 'this fire\'s artifact ledger, no title' },
  { file: 'sidecar/dispatch-delivery.js', anchor: "const repair = final.repairRunId && runStore.latest(final.repairRunId);", reason: 'write integrity of a repair run' },
  { file: 'sidecar/dispatch-delivery.js', anchor: "for (const source of runStore.all()) {", reason: 'pending-delivery recovery' },
  { file: 'sidecar/agent-affinity.js', anchor: "/* rows: durable run rows (runStore.all()).", reason: 'a comment' }
];

const CALL = /runStore\.(?:list|all|latest)\(/g;
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

// check(files) -> problems[]. files = [{ rel, text }]
function check(files) {
  const problems = [];
  const byRel = new Map(files.map(f => [f.rel, f.text]));
  const covered = new Map();   // rel -> [[start, end, label]]
  const cover = (rel, start, end, label) => { if (!covered.has(rel)) covered.set(rel, []); covered.get(rel).push([start, end, label]); };
  const find = (rel, anchor) => {
    const text = byRel.get(rel) || '';
    const at = []; for (let i = text.indexOf(anchor); i >= 0; i = text.indexOf(anchor, i + 1)) at.push(i);
    return at;
  };
  for (const t of TAGGED) {
    const at = find(IDX, t.anchor);
    if (at.length !== 1) { problems.push('tagged site ' + t.key + ' matches ' + at.length + ' time(s), expected 1: ' + t.anchor.slice(0, 90)); continue; }
    const text = byRel.get(IDX);
    if (!t.follow && t.anchor.indexOf("runView('" + t.key + "'") < 0) problems.push('tagged site ' + t.key + ' does not hold its runView tag');
    if (t.follow) {
      const tail = text.slice(at[0], at[0] + 1500);
      if (tail.indexOf(t.follow) < 0) problems.push('tagged site ' + t.key + ' never applies its tag: ' + t.follow);
    }
    cover(IDX, at[0], at[0] + t.anchor.length, 'runView ' + t.key);
  }
  for (const a of ALLOWED) {
    const at = find(a.file, a.anchor), want = a.count || 1;
    if (at.length !== want) { problems.push('allowed site matches ' + at.length + ' time(s), expected ' + want + ': ' + a.anchor.slice(0, 90)); continue; }
    if (!a.reason || a.reason.length < 8) problems.push('allowed site has no reason: ' + a.anchor.slice(0, 60));
    for (const i of at) cover(a.file, i, i + a.anchor.length, 'allow');
  }
  for (const f of files) {
    for (const m of f.text.matchAll(CALL)) {
      const spans = (covered.get(f.rel) || []).filter(([s, e]) => m.index >= s && m.index < e);
      if (spans.length !== 1) problems.push(f.rel + ':' + lineOf(f.text, m.index) + ' ' + m[0] + ') is ' + (spans.length ? 'covered ' + spans.length + ' times' : 'neither tagged runView nor allowed with a reason'));
    }
  }
  return problems;
}

const files = sidecarSourceFiles();
const real = check(files);
A.eq(real, [], 'every runStore list/all/latest call in the sidecar is tagged runView or allowed with a reason');

// the helper itself: runView is the ForgetRegistry filter, defined once, directly after sessionRunForgotten
{
  const idx = files.find(f => f.rel === IDX).text;
  const forgotten = idx.indexOf('function sessionRunForgotten(r)');
  const view = idx.indexOf('function runView(name, r) {');
  A.ok(forgotten > 0 && view > forgotten && view - forgotten < 2600, 'function runView(name, r) sits directly after sessionRunForgotten');
  A.eq((idx.match(/function runView\(/g) || []).length, 1, 'runView is defined once');
  A.ok(/ForgetRegistry\.viewRun\(r, runViewCtx\)/.test(idx.slice(view, view + 400)), 'runView is the registry\'s pure filter over the session ledger');
  A.ok(!/sessionRunForgotten\(r\)\)/.test(idx.replace('function sessionRunForgotten(r) { return', '')), 'no reader asks sessionRunForgotten directly any more: runView subsumes it');
  const tags = new Set(); for (const m of idx.matchAll(/runView\('([A-Za-z]+)'/g)) tags.add(m[1]);
  A.eq(Array.from(tags).sort(), Array.from(new Set(TAGGED.map(t => t.key))).sort(), 'the tags in use are exactly the table\'s keys');
}

// the interrupted-run list is a family reader of the same forget predicate: every serializer of a journal record is the one DTO, and the DTO asks it
{
  const idx = files.find(f => f.rel === IDX).text;
  const dto = idx.indexOf('function runRecoveryDto(r) {');
  const dtoBody = idx.slice(dto, idx.indexOf('function serveRunRecoveries', dto));
  A.ok(dto > 0 && /const forgotten = runRecoveryForgotten\(r\);/.test(dtoBody), 'runRecoveryDto asks the forget predicate');
  for (const f of ['userTitle', 'cronJobName', 'messages']) A.ok(new RegExp(f + ':[^\n]*forgotten').test(dtoBody), 'runRecoveryDto blanks ' + f + ' for a forgotten run');
  const serve = idx.slice(idx.indexOf('function serveRunRecoveries'), idx.indexOf('async function handleRunRecoveryResolve'));
  A.ok(/\.map\(runRecoveryDto\)/.test(serve), 'the recoveries list serializes through runRecoveryDto');
  const raw = idx.split('\n').filter(l => /\.checkpoint\b[^;]*\bmessages\b/.test(l) && /(json|respond)/i.test(l));
  A.eq(raw, [], 'no route writes checkpoint messages outside the DTO');
}

// fixtures: the checker catches a new reader, a reverted site and a stale needle
{
  const extra = files.concat([{ rel: 'sidecar/new-reader.js', text: 'const titles = runStore.list(null, { limit: 5 }).map(r => r.title);\n' }]);
  const p1 = check(extra);
  A.ok(p1.length === 1 && /new-reader\.js:1 runStore\.list\(\) is neither tagged runView nor allowed/.test(p1[0]), 'a NEW untagged reader fails: ' + JSON.stringify(p1));
  const reverted = files.map(f => f.rel === IDX ? { rel: f.rel, text: f.text.replace("const allRows = runStore.all().filter(r => runView('runs', r));", 'const allRows = runStore.all();') } : f);
  const p2 = check(reverted);
  A.ok(p2.some(p => /runs matches 0 time/.test(p)) && p2.some(p => /index\.js:\d+ runStore\.all\(\) is neither/.test(p)), 'serveRuns reverted to an unfiltered read fails (the pinned incident): ' + JSON.stringify(p2).slice(0, 300));
  const dropped = files.map(f => f.rel === IDX ? { rel: f.rel, text: f.text.replace("const was = runStore.latest(retryOf);", 'const was = null;') } : f);
  A.ok(check(dropped).some(p => /allowed site matches 0 time/.test(p)), 'an allowlist needle that no longer matches fails (a moved site is re-reviewed)');
  const rewritten = files.map(f => f.rel === IDX ? { rel: f.rel, text: f.text.replace("runsFor: streamId => runStore.list(null, { streamId, limit: 200 })", "runsFor: streamId => runView('runs', runStore.list(null, { streamId, limit: 200 }))") } : f);
  A.ok(check(rewritten).some(p => /allowed site matches 0 time/.test(p)), 'one pinned runsFor rewritten through runView fails the lint: its reader is re-reviewed with the census that slices it (outcome-family.census)');
}

A.report('run-view.lint');
