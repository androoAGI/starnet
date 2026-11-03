/* node test/run-outcome.test.js — the ONE run-outcome resolver (frontend/app/runoutcome.js), as a table.

   How a run ended is settled once, from the facts the station has (the end reason, the provider's finishReason, the
   failure code, a Task Brief question), and every surface reads the code. This locks the rule itself: each terminal
   reason, each refinement, the no-terminal default (failed, never done), the stamp a station puts on agent.run.end, the
   sink pairing an end with its OWN run's error, the run-history row, and the provider-code vocabulary in step with
   sidecar/providers/errorClass.js. The cross-surface invariant is test/outcome-roundtrip.table.test.js. */
'use strict';
const A = require('./_assert.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const ErrorClass = require('../sidecar/providers/errorClass.js');

// ---- 1. the table: facts -> outcome + failureCode ----
const TABLE = [
  [{ reason: 'done' }, 'succeeded', ''],
  [{ reason: 'done', finishReason: 'length' }, 'cut_short', ''],
  [{ reason: 'done', finishReason: 'content_filter' }, 'cut_short', ''],
  [{ reason: 'done', clarifying: true }, 'asked', ''],
  [{ reason: 'done', clarifying: true, finishReason: 'length' }, 'asked', ''],
  [{ reason: 'clarifying' }, 'asked', ''],
  [{ reason: 'error', failureCode: 'rate_limit' }, 'failed', 'rate_limit'],
  [{ reason: 'error', failureCode: 'template_refusal' }, 'failed', 'template_refusal'],
  [{ reason: 'error' }, 'failed', 'run_failure'],
  [{ reason: 'error', failureCode: 'content_policy_blocked' }, 'refused', 'content_policy_blocked'],
  [{ reason: 'refusal' }, 'refused', 'model_refusal'],
  [{ reason: 'cancelled' }, 'stopped', ''],
  [{ reason: 'cancelled', failureCode: 'rate_limit' }, 'stopped', ''],
  [{ reason: 'budget' }, 'out_of_budget', ''],
  [{ reason: 'max_iters' }, 'step_limit', ''],
  [{ reason: 'empty' }, 'empty', ''],
  [{ reason: 'interrupted' }, 'interrupted', ''],
  // nothing proves how it ended: failed, never done (bug 812c3bfb family)
  [{}, 'failed', 'no_terminal_outcome'],
  [{ reason: '' }, 'failed', 'no_terminal_outcome'],
  [{ reason: 'finished-ish' }, 'failed', 'no_terminal_outcome'],
  [{ reason: 'constructor' }, 'failed', 'no_terminal_outcome'],
  [{ reason: 'toString' }, 'failed', 'no_terminal_outcome']
];
for (const [facts, outcome, code] of TABLE) {
  const r = RunOutcome.resolve(facts);
  A.eq([r.outcome, r.failureCode, r.ok], [outcome, code, outcome === 'succeeded'], JSON.stringify(facts) + ' -> ' + outcome + (code ? '/' + code : ''));
  A.ok(RunOutcome.OUTCOMES.indexOf(r.outcome) >= 0, JSON.stringify(facts) + ': the outcome is in the vocabulary');
}
A.eq(RunOutcome.resolve(null).outcome, 'failed', 'no facts at all is a failure');

// ---- 2. a stream's end (and its error) ----
A.eq(RunOutcome.ofEnd(null, null), { outcome: 'failed', failureCode: 'no_terminal_outcome', ok: false }, 'no agent.run.end: no terminal outcome');
A.eq(RunOutcome.ofEnd(null, { failureCode: 'unreachable' }).failureCode, 'unreachable', 'no end after a coded error: the error\'s code');
A.eq(RunOutcome.ofEnd({ reason: 'error' }, { failureCode: 'rate_limit' }).failureCode, 'rate_limit', 'an end without a code takes its error\'s');
A.eq(RunOutcome.ofEnd({ reason: 'error', failureCode: 'quota_exhausted' }, { failureCode: 'rate_limit' }).failureCode, 'quota_exhausted', 'the end\'s own code wins');
A.eq(RunOutcome.ofEnd({ reason: 'done', finishReason: 'length' }).outcome, 'cut_short', 'a cut end');
A.eq(RunOutcome.ofEnd({ reason: 'done', outcome: 'asked' }).outcome, 'asked', 'a station stamp wins over the bare reason');
A.eq(RunOutcome.ofEnd({ reason: 'done', outcome: 'definitely' }).outcome, 'succeeded', 'a stamp outside the vocabulary is ignored');
A.eq(RunOutcome.ofEnd({ reason: 'error', outcome: 'failed' }).failureCode, 'run_failure', 'a failed stamp always names a code');
A.eq(RunOutcome.ofEnd({ reason: 'done', outcome: 'succeeded', failureCode: 'rate_limit' }).failureCode, '', 'a run that did not fail carries no failure code');
// an error the run raised outranks an end that still says done (an image task's unmet completion)
A.eq(RunOutcome.ofEnd({ reason: 'done' }, { message: 'no image was made' }), { outcome: 'failed', failureCode: 'run_failure', ok: false }, 'its own error + a done end: failed');
A.eq(RunOutcome.ofEnd({ reason: 'done', finishReason: 'length' }, { failureCode: 'output_limit_tool_cut' }).failureCode, 'output_limit_tool_cut', 'a cut end after an error: failed with the error\'s code');
A.eq(RunOutcome.ofEnd({ reason: 'cancelled' }, { message: 'x' }).outcome, 'stopped', 'a stop stays a stop');

// ---- 3. the stamp the station puts on agent.run.end ----
{
  const end = { agentId: 'a', runId: 'r', reason: 'error', turns: 1, usd: 0 };
  const s = RunOutcome.stamp(end, { runId: 'r', failureCode: 'template_refusal' });
  A.eq([s.outcome, s.failureCode], ['failed', 'template_refusal'], 'a failed end is stamped with its error\'s code');
  A.ok(s !== end && !('outcome' in end), 'the stamp copies — the payload it was given is untouched');
  const ok = RunOutcome.stamp({ runId: 'r', reason: 'done', turns: 1, usd: 0 });
  A.eq([ok.outcome, 'failureCode' in ok], ['succeeded', false], 'a clean end is stamped succeeded and carries no failureCode');
  const pre = { runId: 'r', reason: 'done', outcome: 'cut_short' };
  A.ok(RunOutcome.stamp(pre) === pre, 'an end already stamped passes as is');
  A.eq(RunOutcome.stamp(null), null, 'nothing to stamp');
}

// ---- 4. the sink: every end that passes is stamped, paired with its OWN run's error ----
{
  const seen = [], told = [];
  const emit = RunOutcome.sink((n, p) => seen.push([n, p]), (rid, o) => told.push([rid, o.outcome, o.failureCode]));
  emit('agent.run.error', { runId: 'lead', message: 'x', transient: false, failureCode: 'rate_limit' });
  emit('agent.run.end', { runId: 'worker', reason: 'error', turns: 0, usd: 0 });     // a forwarded worker's end never takes the lead's error
  emit('agent.run.end', { runId: 'lead', reason: 'error', turns: 0, usd: 0 });
  emit('agent.token', { runId: 'lead', delta: 'hi' });
  const ends = seen.filter(e => e[0] === 'agent.run.end').map(e => [e[1].runId, e[1].outcome, e[1].failureCode]);
  A.eq(ends, [['worker', 'failed', 'run_failure'], ['lead', 'failed', 'rate_limit']], 'each end is stamped with its own run\'s error code');
  A.eq(told, [['worker', 'failed', 'run_failure'], ['lead', 'failed', 'rate_limit']], 'and the host is told the same outcome for the history row');
  A.eq(seen.length, 4, 'every event still passes, once');
  const bufferedThenRewritten = [];
  const e2 = RunOutcome.sink((n, p) => bufferedThenRewritten.push(p));
  e2('agent.run.end', Object.assign({ runId: 'r', reason: 'done', turns: 1, usd: 0 }, { reason: 'clarifying' }));
  A.eq(bufferedThenRewritten[0].outcome, 'asked', 'an end the host rewrote (a Task Brief question) is stamped from what it finally says');
}

// ---- 5. a run-history row ----
A.eq(RunOutcome.ofRow({ reason: 'done', clarifying: true }).outcome, 'asked', 'a clarifying row');
A.eq(RunOutcome.ofRow({ reason: 'done', outcome: 'cut_short' }).outcome, 'cut_short', 'a row the station stamped keeps its stamp');
A.eq(RunOutcome.ofRow({ reason: 'error', failureCode: 'no_terminal_outcome' }), { outcome: 'failed', failureCode: 'no_terminal_outcome', ok: false }, 'a thrown run\'s row');
A.eq(RunOutcome.ofRow(null).outcome, 'failed', 'no row proves nothing');

// ---- 6. the provider vocabulary stays in step with the classifier ----
for (const reason of Object.keys(ErrorClass.REASONS)) A.ok(RunOutcome.isProviderCode(reason), 'errorClass reason ' + reason + ' is a provider code');
A.ok(!RunOutcome.isProviderCode('spend_history_unavailable') && !RunOutcome.isProviderCode('no_terminal_outcome'), 'StarNet\'s own stops are not provider codes');
for (const c of ['rate_limit', 'auth', 'template_refusal', 'quota_exhausted']) A.ok(RunOutcome.providerAnswered(c), c + ': the provider answered (and refused)');
for (const c of ['unreachable', 'timeout', 'tls_certificate', 'overloaded']) A.ok(!RunOutcome.providerAnswered(c), c + ': nothing usable answered');

// ---- 7. one line of words ----
A.eq(RunOutcome.line({ outcome: 'failed', failureCode: 'rate_limit' }), 'failed (rate_limit)', 'a failed line names its code');
A.eq(RunOutcome.line({ outcome: 'step_limit' }), 'reached the step limit', 'a stop line is words, never the raw reason');
A.eq(RunOutcome.line({ outcome: 'refused', failureCode: 'model_refusal' }), 'the model declined the request', 'a bare refusal');
for (const o of RunOutcome.OUTCOMES) A.ok(typeof RunOutcome.line({ outcome: o }) === 'string' && RunOutcome.line({ outcome: o }).length > 3, o + ' has words');

A.report('run-outcome.test');
