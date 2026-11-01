/* node test/runstore.test.js — the append-only run-history store (M-save P4).
   An in-memory io proves: a run outcome round-trips, the reason is clamped to the known enum, the title is
   length-capped, list() returns newest-first filtered by agentId and respects the limit, ts comes from the
   injected clock, and the on-disk log is replayed into a fresh store. Pure + deterministic. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeRunStore } = require('../sidecar/runstore.js');

// in-memory io mirroring the host's JSONL adapter (readAll + append).
function memIo() {
  const lines = [];
  return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } };
}
let clk = 1000;
const clock = { now: () => clk };

// ---- A. record stamps ts from the clock, returns the entry, persists it ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock });
  clk = 1111;
  const e = s.record({ runId: 'r1', agentId: 'agent', reason: 'done', turns: 3, tokens: 500, usd: 0.02, title: 'fix the bug' });
  A.eq(e.runId, 'r1', 'runId recorded');
  A.eq(e.reason, 'done', 'reason recorded');
  A.eq(s.record({ runId: 'r2', reason: 'done', clarifying: true }).clarifying, true, 'clarification outcome is stored separately from the execution terminal');
  A.eq(e.ts, 1111, 'ts stamped from injected clock');
  A.eq(s.count(), 2, 'both rows recorded');
  A.eq(io.lines.length, 2, 'both rows appended to io');
}

// ---- B. reason clamped to the known enum; unknown -> 'error' (bug 812c3bfb: an unknown end is never a finished run) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  A.eq(s.record({ runId: 'r', reason: 'refusal' }).reason, 'refusal', 'valid reason kept');
  A.eq(s.record({ runId: 'r', reason: 'budget' }).reason, 'budget', 'budget reason kept');
  A.eq(s.record({ runId: 'r', reason: 'empty' }).reason, 'empty', 'provider-empty remains empty (never rewritten as success)');
  A.eq(s.record({ runId: 'r', reason: 'clarifying' }).reason, 'clarifying', 'a Task Brief question remains neutral (never rewritten as success)');
  A.eq(s.record({ runId: 'r', reason: 'kaboom' }).reason, 'error', 'unknown reason clamped to error, never done');
  A.eq(s.record({ runId: 'r' }).reason, 'error', 'a missing reason (a run that threw) records as error, never done');
  A.eq(s.record({ runId: 'r', reason: 'done' }).reason, 'done', 'a real done is kept');
}

// ---- C. title is length-capped (no unbounded blob on disk) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'r', title: 'x'.repeat(500) });
  A.ok(e.title.length <= 120, 'title capped to 120 chars');
}

// ---- D. list(): newest-first, filtered by agentId, limit respected ----
{
  const s = makeRunStore({ io: memIo(), clock });
  clk = 1; s.record({ runId: 'a1', agentId: 'A' });
  clk = 2; s.record({ runId: 'b1', agentId: 'B' });
  clk = 3; s.record({ runId: 'a2', agentId: 'A' });
  const A_runs = s.list('A');
  A.eq(A_runs.map(r => r.runId), ['a2', 'a1'], 'agent A runs newest-first');
  A.eq(s.list('B').map(r => r.runId), ['b1'], 'agent B filtered');
  A.eq(s.list(null).length, 3, 'no agentId -> all runs');
  A.eq(s.list('A', { limit: 1 }).map(r => r.runId), ['a2'], 'limit respected (newest)');
  A.eq(s.list('NONE'), [], 'unknown agent -> empty');
  A.eq(s.list(null, { limit: 1, beforeRunId: 'a2' }).map(r => r.runId), ['b1'], 'cursor continues strictly before the prior page tail');
  A.eq(s.list(null, { since: 1, through: 2 }).map(r => r.runId), ['b1'], 'time window is applied before the page limit');
}

// ---- E. durable: a fresh store replays the on-disk log ----
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  s.record({ runId: 'r1', agentId: 'agent', reason: 'done' });
  s.record({ runId: 'r2', agentId: 'agent', reason: 'error' });
  s = makeRunStore({ io, clock });   // rebuilt from the same io
  A.eq(s.count(), 2, 'history replayed into a fresh store');
  A.eq(s.list('agent').map(r => r.runId), ['r2', 'r1'], 'replayed order intact');
}

// ---- F. corrupt/missing log -> empty history, record still works (fail-open) ----
{
  const bad = { readAll() { throw new Error('corrupt'); }, append() {} };
  const s = makeRunStore({ io: bad, clock });
  A.eq(s.count(), 0, 'corrupt log -> empty');
  A.eq(s.record({ runId: 'r', reason: 'done' }).runId, 'r', 'record still works over a corrupt log');
}

// ---- G. (H3.2) a run records its streamId so the RUNS row can open its transcript ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'r9', agentId: 'a', reason: 'done', streamId: 'general' });
  A.eq(e.streamId, 'general', 'record stores the run\'s streamId');
  A.eq(s.list('a')[0].streamId, 'general', 'list surfaces streamId (join key to GET /api/transcript)');
  A.eq(s.record({ runId: 'r10', agentId: 'a' }).streamId, '', 'a streamless run -> empty streamId (no crash)');
}

// ---- G2. recipe provenance spine: a recipe-launched run records WHICH recipe fired it (additive) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'rp1', agentId: 'a', reason: 'done', recipeId: 'morning-brief' });
  A.eq(e.recipeId, 'morning-brief', 'record stores the launching recipeId');
  A.eq(s.list('a')[0].recipeId, 'morning-brief', 'list surfaces recipeId (the outcome-loop join key)');
  A.eq(s.record({ runId: 'rp2', agentId: 'a' }).recipeId, '', 'a non-recipe run -> empty recipeId (old rows fail-open)');
  A.eq(s.record({ runId: 'rp3', agentId: 'a', recipeId: 'x'.repeat(200) }).recipeId.length, 60, 'recipeId is clamped to 60 chars');
}

// ---- H. model identity is durable; subscription runs are explicitly unmetered ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'm1', agentId: 'a', provider: '  openai  ', model: '  gpt-5.5  ', unmetered: true, usd: 0, tokens: 900000 });
  A.eq(e.provider, 'openai', 'provider is trimmed and recorded beside the actual model');
  A.eq(e.model, 'gpt-5.5', 'model is trimmed and recorded');
  A.eq(e.unmetered, true, 'unmetered flag is recorded');
  A.eq(s.list('a')[0].model, 'gpt-5.5', 'list surfaces model identity');
  A.eq(s.list('a')[0].provider, 'openai', 'list surfaces provider identity for diagnostics');
  A.eq(s.record({ runId: 'm2', agentId: 'a', model: '' }).model, '(unknown)', 'empty model becomes explicit unknown');
}

// ---- I. (work-visibility) artifacts ride the entry: sanitized, capped, [] default ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock });
  const e = s.record({ runId: 'w1', agentId: 'a', reason: 'done', artifacts: [
    { kind: 'file', path: 'report.md', bytes: 2150 },
    { kind: 'image', path: 'images/gen-ab.png' },
    { kind: 'message', target: 'telegram' },
    { kind: 'bogus', path: 'nope' },                    // unknown kind dropped
    { kind: 'file' },                                    // no path/target -> dropped
    'garbage', null                                      // non-objects dropped
  ] });
  A.eq(e.artifacts, [
    { kind: 'file', path: 'report.md', bytes: 2150 },
    { kind: 'image', path: 'images/gen-ab.png' },
    { kind: 'message', target: 'telegram' }
  ], 'artifacts sanitized to known kinds with path/target/bytes only');
  A.eq(s.record({ runId: 'w2', agentId: 'a' }).artifacts, [], 'missing artifacts defaults to []');
  A.eq(s.record({ runId: 'w3', agentId: 'a', artifacts: 'nope' }).artifacts, [], 'non-array artifacts defaults to []');
  const big = s.record({ runId: 'w4', agentId: 'a', artifacts: Array.from({ length: 80 }, (_, i) => ({ kind: 'file', path: 'f' + i })) });
  A.eq(big.artifacts.length, 50, 'artifacts capped at 50 records');
  const long = s.record({ runId: 'w5', agentId: 'a', artifacts: [{ kind: 'file', path: 'x'.repeat(999) }] });
  A.ok(long.artifacts[0].path.length <= 260, 'artifact path capped at 260 chars');
  A.eq(io.lines[0].artifacts.length, 3, 'artifacts persisted on the appended JSONL row');
  // ---- (crate-honesty) toolsOk rides the row: proven work count, 0 default ----
  A.eq(s.record({ runId: 'w6', agentId: 'a', reason: 'done', toolsOk: 4 }).toolsOk, 4, 'toolsOk recorded on the row');
  A.eq(s.record({ runId: 'w7', agentId: 'a', reason: 'done' }).toolsOk, 0, 'missing toolsOk defaults to 0 (old rows under-claim, never over)');
  A.eq(s.record({ runId: 'w8', agentId: 'a', toolsOk: 'nope' }).toolsOk, 0, 'non-numeric toolsOk clamps to 0');

  // ---- hierarchical timing telemetry persists as bounded, display-safe facts ----
  const timed = s.record({
    runId: 'worker-timed', parentRunId: 'lead-timed', agentId: 'researcher', model: 'gpt-x', reasoningEffort: 'medium',
    startedAt: 100, endedAt: 355, durationMs: 255, toolTrace: [
      { callId: 'c1', name: 'web_fetch', ok: false, isError: true, ms: 251, summary: 'domain not found', startedAt: 101, endedAt: 352 }
    ]
  });
  A.eq(timed.parentRunId, 'lead-timed', 'worker parentRunId persists for hierarchy joins');
  A.eq(timed.reasoningEffort, 'medium', 'actual reasoning effort persists');
  A.eq(timed.durationMs, 255, 'actual run duration persists');
  A.eq(timed.toolTrace[0].ms, 251, 'actual per-tool duration persists');
  A.eq(io.lines.find(x => x.runId === 'worker-timed').toolTrace[0].summary, 'domain not found', 'tool timing survives the append boundary');
  const reloadedTimed = makeRunStore({ io, clock }).list('researcher').find(x => x.runId === 'worker-timed');
  A.eq(reloadedTimed.parentRunId, 'lead-timed', 'parent/child join survives a store restart');
  A.eq(reloadedTimed.toolTrace[0].ms, 251, 'per-tool milliseconds survive a store restart');
  const cappedTrace = s.record({ runId: 'trace-cap', toolTrace: Array.from({ length: 250 }, (_, i) => ({ callId: 'c' + i, name: 'tool', ms: -1, summary: 'x'.repeat(500) })) });
  A.eq(cappedTrace.toolTrace.length, 200, 'tool trace is capped at 200 calls');
  A.eq(cappedTrace.toolTrace[0].ms, 0, 'negative tool durations clamp to zero');
  A.ok(cappedTrace.toolTrace[0].summary.length <= 240, 'tool summaries are bounded');

  // ---- recovery telemetry: bounded failure classification + only dispatched mutations ----
  const recovery = s.record({
    runId: 'recovery-trace', failureStage: 'tool_result_persist', failureCode: 'recovery-journal-failed',
    uncertainMutations: [
      { callId: 'c-write', name: 'fs.write', mutating: true, state: 'dispatched' },
      { callId: 'c-read', name: 'fs.read', mutating: false, state: 'dispatched' },
      { callId: '', name: 'bad', mutating: true }
    ]
  });
  A.eq(recovery.failureStage, 'tool_result_persist', 'failure lifecycle stage persists');
  A.eq(recovery.failureCode, 'recovery-journal-failed', 'stable failure code persists');
  A.eq(recovery.uncertainMutations, [{ callId: 'c-write', name: 'fs.write', mutating: true, state: 'dispatched' }], 'only valid dispatched mutations persist as uncertainty');
  A.eq(s.record({ runId: 'recovery-defaults' }).uncertainMutations, [], 'legacy and ordinary rows default to no asserted uncertainty');

  const completion = s.record({ runId: 'completion-evidence', completionEvidence: {
    completionVerdict: 'completed_verified', effectVerdict: 'judgment_required',
    effects: [{ callId: 'b1', tool: 'browser.click', domain: 'browser', target: '#save', state: 'judgment_required', evidence: ['ev-1'] }]
  } }).completionEvidence;
  A.eq(completion.completionVerdict, 'not_assessed', 'run store cannot persist a caller-invented completion claim');
  A.eq(completion.effectVerdict, 'judgment_required', 'bounded effect verdict persists');
  A.eq(completion.effects[0].state, 'judgment_required', 'effect-level judgment requirement persists');
  const authority = Symbol('host');
  const trustedStore = makeRunStore({ io: memIo(), clock, completionAuthority: authority });
  const trustedCompletion = trustedStore.record({ runId: 'host-verified', completionEvidence: {
    _completionAuthority: authority,
    completionVerdict: 'completed_verified', effectVerdict: 'mechanically_verified', effects: [],
    contract: { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [{ id: 'file', type: 'artifact_exists', path: 'out.txt' }] },
    checks: [{ id: 'file', type: 'artifact_exists', status: 'passed', code: 'artifact_exists' }]
  } }).completionEvidence;
  A.eq(trustedCompletion.completionVerdict, 'completed_verified', 'matching in-process authority plus complete mechanical checks may persist verification');
  A.eq(trustedCompletion.checks[0].status, 'passed', 'durable completion row retains its bounded check result');
  A.ok(!Object.prototype.hasOwnProperty.call(trustedCompletion, '_completionAuthority'), 'in-process authority is never serialized into run history');
  const forged = trustedStore.record({ runId: 'forged', completionEvidence: Object.assign({}, trustedCompletion, { _completionAuthority: Symbol('host') }) }).completionEvidence;
  A.eq(forged.completionVerdict, 'not_assessed', 'lookalike authority object cannot replay a verified verdict');
  const recoveryAttempts = s.record({ runId: 'recovery-attempts', recoveryAttempts: [
    { sequence: 1, stage: 'provider_stream', action: 'retry', reason: 'timeout', attempt: 1, model: 'm', delayMs: 400 }
  ] }).recoveryAttempts;
  A.eq(recoveryAttempts[0].action, 'retry', 'recovery action persists in run history');
  A.eq(recoveryAttempts[0].delayMs, 400, 'recovery delay persists as observed policy telemetry');

  // ---- (P1.2 identity-honesty) identityFallback rides the row: honest marker when the agentId missed the roster ----
  A.eq(s.record({ runId: 'w9', agentId: 'a', reason: 'done', identityFallback: true }).identityFallback, true, 'identityFallback:true recorded on a fallback run (was not the named specialist)');
  A.eq(s.record({ runId: 'w10', agentId: 'a', reason: 'done' }).identityFallback, false, 'missing identityFallback defaults to false (old rows / normal runs are not falsely flagged)');
  A.eq(s.record({ runId: 'w11', agentId: 'a', identityFallback: 1 }).identityFallback, true, 'truthy identityFallback coerces to a strict boolean');
  A.eq(s.record({ runId: 'w12', agentId: 'a', internal: true }).internal, true, 'reason-only internal runs are marked so progression catch-up can exclude them');
  A.eq(s.record({ runId: 'w13', agentId: 'a' }).internal, false, 'ordinary runs default to non-internal');
  A.eq(s.record({ runId: 'interactive-origin', surface: 'interactive', streamId: 'cron-existing' }).surface, 'interactive', 'run origin survives independently of conversation prefix');
  A.eq(s.record({ runId: 'scheduled-origin', surface: 'autonomous' }).surface, 'autonomous', 'scheduled origin stays distinct');
  A.eq(s.record({ runId: 'unknown-origin', surface: 'invented' }).surface, '', 'unrecognized origins are not accepted as interactive evidence');
}

// ---- J. (work-visibility) OLD JSONL rows WITHOUT artifacts still parse + list (fail-open) ----
{
  const io = memIo();
  // legacy rows, written before the artifacts field existed (exactly the pre-slice entry shape)
  io.lines.push({ runId: 'old1', agentId: 'a', reason: 'done', turns: 2, tokens: 10, usd: 0.01, title: 't', streamId: '', model: 'm', unmetered: false, ts: 5 });
  io.lines.push({ runId: 'old2', agentId: 'a', reason: 'error', turns: 0, tokens: 0, usd: 0, title: '', streamId: '', model: 'm', unmetered: false, ts: 6 });
  const s = makeRunStore({ io, clock });
  A.eq(s.count(), 2, 'legacy rows replay into the store');
  const rows = s.list('a');
  A.eq(rows.map(r => r.runId), ['old2', 'old1'], 'legacy rows list newest-first, unchanged');
  A.ok(!('artifacts' in rows[0]) || Array.isArray(rows[0].artifacts), 'a legacy row is served as-is (no crash, no fabricated field)');
  const e = s.record({ runId: 'new1', agentId: 'a', artifacts: [{ kind: 'file', path: 'n.txt' }] });
  A.eq(e.artifacts, [{ kind: 'file', path: 'n.txt' }], 'new records alongside legacy rows carry artifacts');
  A.eq(s.list('a').map(r => r.runId), ['new1', 'old2', 'old1'], 'mixed old/new history lists together');
}

// ---- K. delegated-session delivery is durable enough for a page that was closed or stale to heal later ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({
    runId: 'delegated-1', agentId: 'researcher', reason: 'done', streamId: 'ws_server_copy',
    sessionTitle: 'business research session',
    deliveryPrompt: 'research three AI businesses',
    deliveryText: 'three sourced ideas'
  });
  A.eq(e.sessionTitle, 'business research session', 'the Commander-visible session name is durable');
  A.eq(e.deliveryPrompt, 'research three AI businesses', 'the delegated instruction is durable for the framing marker');
  A.eq(e.deliveryText, 'three sourced ideas', 'the final answer is durable for missed-page replay');
  A.eq(s.record({ runId: 'plain' }).sessionTitle, '', 'ordinary runs carry no fake delivery target');
  A.eq(s.record({ runId: 'capped', sessionTitle: 's'.repeat(300), deliveryPrompt: 'p'.repeat(5000), deliveryText: 't'.repeat(100000) }).sessionTitle.length, 80, 'session title is bounded');
  A.ok(s.list(null)[0].deliveryPrompt.length <= 4000, 'delivery prompt is bounded');
  A.ok(s.list(null)[0].deliveryText.length <= 24000, 'delivery result is bounded');
}

// ---- RAM mirror trim: the in-process rows array is bounded; disk keeps the full log; recent list unaffected ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock, ramMax: 50 });   // tiny cap for the test
  for (let i = 0; i < 200; i++) s.record({ runId: 'r' + i, agentId: 'a', reason: 'done', usd: 1, title: 't' + i });
  A.eq(s.count(), 50, 'RAM mirror is bounded to ramMax (oldest spliced off)');
  A.eq(io.lines.length, 200, 'disk kept EVERY appended row (only RAM was trimmed)');
  const recent = s.list('a', { limit: 10 });
  A.eq(recent[0].runId, 'r199', 'newest run still listed after trimming');
  A.eq(recent[9].runId, 'r190', 'the last 10 are intact');
  const s2 = makeRunStore({ io, clock, ramMax: 50 });
  A.eq(s2.count(), 50, 'a boot load over the cap is trimmed at construction too');
  A.eq(s2.list('a', { limit: 1 })[0].runId, 'r199', 'the trimmed boot load keeps the NEWEST rows');
}

// ---- L. INTERRUPTED runs (2026-09-22): one served row per run, kept current by append-only updates ----
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  clk = 10; s.record({ runId: 'before', agentId: 'a', reason: 'done' });
  clk = 20;
  const first = s.record({ runId: 'int', agentId: 'a', reason: 'interrupted', turns: 4, startedAt: 5, endedAt: 9, recoveryStatus: 'needs_review', spendUnknown: true, error: 'interrupted:\n  stopped  mid-action' });
  A.eq([first.reason, first.recoveryStatus, first.spendUnknown, first.error], ['interrupted', 'needs_review', true, 'interrupted: stopped mid-action'], 'an interrupted row keeps its reason, recovery status, unknown-spend flag and a one-line error');
  clk = 30; s.record({ runId: 'after', agentId: 'a', reason: 'done' });
  clk = 40; s.record({ runId: 'int', agentId: 'a', reason: 'interrupted', turns: 4, recoveryStatus: 'resolved' });
  clk = 50; s.record({ runId: 'cont', agentId: 'a', reason: 'done', recoveryOf: 'int' });
  clk = 60; s.record({ runId: 'int', agentId: 'a', reason: 'interrupted', turns: 4, recoveryStatus: 'continued', continuedRunId: 'cont', continuedReason: 'done' });
  A.eq(io.lines.length, 6, 'every update is an appended line (the log stays append-only)');
  A.eq(s.count(), 4, 'count() serves one row per run');
  A.eq(s.list(null).map(r => r.runId), ['cont', 'after', 'int', 'before'], 'the interrupted run keeps its original position (no duplicate, no jump)');
  const served = s.list(null).find(r => r.runId === 'int');
  A.eq([served.recoveryStatus, served.continuedRunId, served.continuedReason, served.ts, 'error' in served], ['continued', 'cont', 'done', 20, false], 'the served row carries the NEWEST state at the FIRST row\'s ts');
  A.eq(s.all().filter(r => r.runId === 'int').length, 1, 'all() serves one row per interrupted run');
  A.eq(s.latest('int').recoveryStatus, 'continued', 'latest() returns the collapsed row');
  A.eq(s.list(null).find(r => r.runId === 'cont').recoveryOf, 'int', 'the continuation row links back with recoveryOf');
  A.eq(s.list(null, { limit: 2, beforeRunId: 'after' }).map(r => r.runId), ['int', 'before'], 'a page cursor never re-serves rows around a collapsed chain');
  A.eq(s.list(null, { since: 15, through: 25 }).map(r => r.runId), ['int'], 'the time window applies to the served row\'s original ts');
  s = makeRunStore({ io, clock });
  A.eq([s.count(), s.latest('int').recoveryStatus], [4, 'continued'], 'the collapse survives a reload from disk');
  A.eq(s.record({ runId: 'x', reason: 'interrupted', recoveryStatus: 'bogus', continuedReason: 'nope' }).recoveryStatus, undefined, 'unknown recovery states are not accepted');
  A.eq(Object.keys(s.record({ runId: 'plain2', reason: 'done' })).filter(k => /^(?:recoveryStatus|recoveryOf|continuedRunId|continuedReason|spendUnknown|error)$/.test(k)), [], 'ordinary rows keep their exact pre-existing shape');
  const dup = makeRunStore({ io: memIo(), clock });
  dup.record({ runId: 'same', reason: 'done' }); dup.record({ runId: 'same', reason: 'error' });
  A.eq(dup.count(), 2, 'rows of runs that were never interrupted are never collapsed');
}

// ---- STREAM FILTER (conveyor sweep 2026-09-25): a trigger fire / sample reads back ITS rows by streamId ----
// It used to read the station's newest 50 rows and filter — a busy station pushed the fire's own rows out of that
// window, so a finished fire said "no run was recorded". list({ streamId }) scans the whole window for that stream.
{
  const s = makeRunStore({ io: memIo(), clock });
  s.record({ runId: 'mine-1', agentId: 'a', reason: 'done', streamId: 'trigger-abc' });
  s.record({ runId: 'mine-2', agentId: 'b', reason: 'done', streamId: 'trigger-abc' });
  for (let i = 0; i < 80; i++) s.record({ runId: 'busy-' + i, agentId: 'c', reason: 'done', streamId: 'other-' + i });
  A.eq(s.list(null, { limit: 50 }).filter(r => r.streamId === 'trigger-abc').length, 0, '(the old read: the fire\'s rows are outside the newest 50)');
  const mine = s.list(null, { streamId: 'trigger-abc', limit: 200 });
  A.eq(mine.map(r => r.runId), ['mine-2', 'mine-1'], 'list({ streamId }) returns exactly that stream\'s rows, newest-first');
  A.eq(s.list(null, { streamId: 'nope' }).length, 0, 'an unknown stream has no rows');
  const src = readSidecarSource();
  A.ok(/runsFor: \(streamId\) => \(runStore\.list\(null, \{ streamId: streamId/.test(src), 'the trigger runner reads its fire back by streamId');
  A.ok(/(?:runs|const rows) = \(runStore\.list\(null, \{ streamId: streamId, limit: 200 \}\)/.test(src), 'the sample route reads its runs back by streamId');   // `rows` since the delivered-receipt rule reads them twice
}

// ---- ROUTINE HISTORY (2026-10-01): a scheduled run carries its routine id; ordinary rows stay byte-identical ----
{
  const s = makeRunStore({ io: memIo(), clock });
  A.eq(s.record({ runId: 'c1', cronJobId: 'job-1' }).cronJobId, 'job-1', 'a scheduled run records its routine id');
  A.ok(!('cronJobId' in s.record({ runId: 'i1' })), 'a non-scheduled run has no cronJobId key');
}

// ---- #57: delegatedBy (additive) — who delegated a worker run; absent on every other row, survives a replay ----
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  const w = s.record({ runId: 'w1', parentRunId: 'lead1', delegatedBy: 'strategist', agentId: 'strategist-2', reason: 'done' });
  A.eq(w.delegatedBy, 'strategist', 'a worker row records the lead that delegated it');
  const plain = s.record({ runId: 'c1', parentRunId: 'w1', agentId: 'strategist', reason: 'done' });
  A.ok(!('delegatedBy' in plain), 'a row without a delegator keeps its old shape (no empty field)');
  A.ok(!('delegatedBy' in s.record({ runId: 'x1', delegatedBy: 'bad id!', reason: 'done' })), 'a malformed delegator id is dropped');
  s = makeRunStore({ io, clock });
  A.eq(s.latest('w1').delegatedBy, 'strategist', 'delegatedBy survives a replay from disk');
}

// Dispatch validation finalizes a delivery without rewriting the execution outcome or booking its spend twice.
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  clk = 100; s.record({ runId: 'original', agentId: 'worker', streamId: 'thread', reason: 'budget', usd: 2,
    deliveryText: 'raw unvalidated text', dispatchDelivery: { state: 'pending' } });
  clk = 110; s.record({ runId: 'repair', agentId: 'worker', streamId: 'thread', reason: 'done', usd: 1,
    deliveryText: 'also invalid', dispatchDelivery: { state: 'internal' } });
  clk = 120; s.record({ runId: 'later', agentId: 'worker', reason: 'done', usd: 4 });
  clk = 130; const final = s.finalizeDelivery('original', { text: 'No completion accepted.', reason: 'invalid-result', repairRunId: 'repair' });
  A.eq(final.reason, 'budget', 'dispatch validation never rewrites the original execution terminal');
  A.eq(final.deliveryText, 'raw unvalidated text', 'raw execution output remains available as evidence');
  A.eq(final.dispatchDelivery.reason, 'invalid-result', 'dispatch failure is separate from the execution terminal');
  A.eq(final.dispatchDelivery.text, 'No completion accepted.', 'the authoritative delivery contains the validated outcome');
  A.eq(final.dispatchDelivery.repairRunId, 'repair', 'the repair remains linked as its own real execution');
  A.eq(final.ts, 100, 'finalization preserves the original run position and time');
  A.eq(s.list().map(r => r.runId), ['later', 'repair', 'original'], 'a delivery patch is never a second run row');
  A.eq(s.all().reduce((sum, r) => sum + r.usd, 0), 7, 'delivery finalization does not duplicate spend');
  A.eq(s.count(), 3, 'delivery finalization does not duplicate run counts');
  A.eq(s.list(null, { beforeRunId: 'repair' }).map(r => r.runId), ['original'], 'pagination ignores delivery patches');
  const lines = io.lines.length;
  A.eq(s.finalizeDelivery('original', { text: 'replacement', reason: 'done' }).dispatchDelivery.reason, 'invalid-result', 'a finalized result cannot be silently replaced');
  A.eq(io.lines.length, lines, 'finalization is idempotent without another disk append');
  A.eq(s.finalizeDelivery('repair', { text: 'repair', reason: 'done' }), null, 'an internal repair cannot deliver independently');
  A.eq(s.finalizeDelivery('missing', { text: 'invented', reason: 'done' }), null, 'a missing execution never becomes invented run/spend history');
  A.eq(s.finalizeDelivery('later', { text: 'legacy', reason: 'done' }), null, 'legacy rows are not rewritten');
  s = makeRunStore({ io, clock });
  A.eq(s.latest('original').dispatchDelivery, final.dispatchDelivery, 'the final delivery survives a fresh store replay');
  A.eq(s.count(), 3, 'replay keeps one row per real execution');
  A.eq(s.latest('repair').dispatchDelivery.state, 'internal', 'repair non-delivery survives restart');
  A.ok(!('dispatchDelivery' in s.latest('later')), 'legacy shape is unchanged');
  const read = s.latest('original'); read.dispatchDelivery.text = 'mutated by reader';
  A.eq(s.latest('original').dispatchDelivery.text, 'No completion accepted.', 'readers cannot mutate the persisted delivery envelope');
}
{
  const io = memIo(); let fail = false;
  const append = io.append.bind(io); io.append = row => { if (fail) throw new Error('disk full'); append(row); };
  const s = makeRunStore({ io, clock });
  s.record({ runId: 'pending', reason: 'done', dispatchDelivery: { state: 'pending' } });
  fail = true; let error = null;
  try { s.finalizeDelivery('pending', { text: 'validated', reason: 'done' }); } catch (e) { error = e; }
  A.ok(error && /disk full/.test(error.message), 'persistence failure is reported to the dispatch host');
  A.eq(s.latest('pending').dispatchDelivery.state, 'pending', 'failed persistence cannot claim a durable finalized delivery');
  fail = false; s.finalizeDelivery('pending', { text: 'validated', reason: 'done' });
  A.eq(makeRunStore({ io, clock }).latest('pending').dispatchDelivery.text, 'validated', 'a failed append can be retried and replayed');
}

{
  const lines = []; let fail = true;
  const io = { readAll: () => lines.slice(), append: row => { if (fail) throw new Error('disk full before run record'); lines.push(row); } };
  const s = makeRunStore({ io, clock });
  s.record({ runId: 'lost-base', reason: 'done', dispatchDelivery: { state: 'pending' } });
  fail = false; let error = null;
  try { s.finalizeDelivery('lost-base', { text: 'answer', reason: 'done' }); } catch (e) { error = e; }
  A.ok(error && /original dispatch run/.test(error.message), 'a missing durable base cannot masquerade as a recoverable finalized delivery');
  A.eq(s.latest('lost-base').dispatchDelivery.state, 'pending', 'failed base persistence leaves delivery unconfirmed');
  A.eq(lines.length, 0, 'no orphan finalization patch is written after the original record failed');
}

// The real host adapter must propagate a strict delivery write failure (ordinary run history stays fail-open).
{
  const fs = require('fs'), vm = require('vm');
  const source = readSidecarSource();
  const start = source.indexOf('const runsIo = {'), end = source.indexOf('// In-process capability', start);
  const io = vm.runInNewContext(source.slice(start, end) + '; runsIo;', {
    fs: {}, RUNS_FILE: 'runs.jsonl', readBoundedJsonl: () => [], failNote: () => {}, rotateJsonl: () => {},
    console: { warn: () => {} }, appendJsonlDurable: () => { throw new Error('host disk failure'); }
  });
  let ordinary = null, strict = null;
  try { io.append({}); } catch (e) { ordinary = e; }
  try { io.append({}, { strict: true }); } catch (e) { strict = e; }
  A.eq(ordinary, null, 'legacy run record append policy remains fail-open');
  A.ok(strict && /host disk failure/.test(strict.message), 'the actual host adapter reports strict finalization persistence failure');
}

// ---- ownerDirective (additive, 2026-10-12) — the host proved the Commander gave this run's directive ----
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  A.eq(s.record({ runId: 'o1', agentId: 'agent', reason: 'done', ownerDirective: true }).ownerDirective, true, 'an owner directive is recorded');
  A.ok(!('ownerDirective' in s.record({ runId: 'g1', agentId: 'agent', reason: 'done', ownerDirective: false })), 'a guest run keeps the old shape (no false field)');
  A.ok(!('ownerDirective' in s.record({ runId: 'g2', agentId: 'agent', reason: 'done', ownerDirective: 'true' })), 'only the boolean host stamp is kept');
  s = makeRunStore({ io, clock });
  A.eq(s.latest('o1').ownerDirective, true, 'ownerDirective survives a replay from disk');
}

// ---- token-burn audit 2026-10-17: the cache-served part of a run's input rides the row (additive, only when > 0) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  A.eq(s.record({ runId: 'c1', tokens: 1000, cachedTokens: 800 }).cachedTokens, 800, 'cachedTokens is recorded on the run row');
  A.ok(!('cachedTokens' in s.record({ runId: 'c2', tokens: 1000 })), 'a run with no cache reads keeps the old row shape (no key)');
  A.ok(!('cachedTokens' in s.record({ runId: 'c3', tokens: 1000, cachedTokens: 'x' })), 'a garbage value is dropped, never stored');
}

A.report('runstore.test');
