/* node test/learning-eligibility.matrix.test.js — memory-truth-1027 (releases#7, quick win 19): ONE rule for which runs
   may teach the station, read by every learning pass.

   Before: each run-end gate carried its own guards and they drifted — a run whose approval was refused stopped reaching
   reflection (10-17) but still reached STUDY and THREAD MINING; a line hand-off stopped reaching reflection, study and
   thread mining (09-30) but still reached the FAILURE REVIEW; tainted / quoted transcripts were spliced out of the
   candidate list by a separate loop. This matrix drives done · failed · denied · cancelled × clean · tainted · quoted ·
   line hop through learning-eligibility.js and asserts the verdict of every pass, then locks that every gate in
   runOnceCore reads that one predicate (and no private copy of the guards is left). */
'use strict';
const A = require('./_assert.js');
const LE = require('../sidecar/learning-eligibility.js');
const { sidecarTopLevelFunction } = require('./helpers/source');

const PASSES = ['reflection', 'study', 'threadmine', 'failure-review', 'trusted-capture'];
const TRANSCRIPT = ['reflection', 'study', 'threadmine', 'failure-review'];
const base = { reflect: true, task: true, internal: false, recovery: false };
const KIND_FACTS = {
  done: { reason: 'done' },
  failed: { reason: 'error' },
  denied: { reason: 'done', denied: true },
  cancelled: { reason: 'cancelled' }
};
const MOD_FACTS = { clean: {}, tainted: { tainted: true }, quoted: { quoted: true }, lineHop: { lineHop: true } };

/* ---------- 1. the matrix ---------- */
// the ONE expected table: which pass may learn from which outcome, under which modifier
const expect = (kind, mod, pass) => {
  if (mod === 'lineHop') return false;                                   // a hand-off frame is never the Commander speaking
  if (pass === 'trusted-capture') return kind === 'done' || kind === 'failed' || kind === 'denied';   // reads only the captured directive
  if (mod !== 'clean') return false;                                     // outside / quoted material withholds every transcript pass
  if (pass === 'failure-review') return kind === 'failed';
  return kind === 'done';                                                // reflection · study · threadmine
};
for (const kind of Object.keys(KIND_FACTS)) {
  for (const mod of Object.keys(MOD_FACTS)) {
    const outcome = LE.runOutcome(Object.assign({}, base, KIND_FACTS[kind], MOD_FACTS[mod]));
    A.eq(outcome.kind, kind, 'classified ' + kind + ' (' + mod + ')');
    const verdict = LE.passes(outcome);
    for (const pass of PASSES) A.eq(verdict[pass], expect(kind, mod, pass), kind + ' × ' + mod + ' → ' + pass);
    // IDENTICAL eligibility: the three passes that read a finished run's transcript always agree, and the failure
    // review mirrors them on a failed run — no pass has a private exception
    A.ok(verdict.reflection === verdict.study && verdict.study === verdict.threadmine, kind + ' × ' + mod + ': reflection, study and thread mining agree');
    const doneTwin = LE.passes(LE.runOutcome(Object.assign({}, base, KIND_FACTS.done, MOD_FACTS[mod]))).reflection;
    const failedTwin = LE.passes(LE.runOutcome(Object.assign({}, base, KIND_FACTS.failed, MOD_FACTS[mod])))['failure-review'];
    A.eq(failedTwin, doneTwin, mod + ': the failure review applies the same modifiers to a failed run as reflection does to a done one');
  }
}
// quick win 19 by name: a refused approval reaches no transcript pass; a line hop reaches no pass, the failure review included
{
  const denied = LE.passes(LE.runOutcome(Object.assign({}, base, { reason: 'done', denied: true })));
  A.ok(!denied.study && !denied.threadmine && !denied.reflection, 'QW19: a run whose approval was refused is studied and thread-mined no more than it is reflected on');
  const deniedFail = LE.passes(LE.runOutcome(Object.assign({}, base, { reason: 'max_iters', denied: true })));
  A.ok(!deniedFail['failure-review'] && deniedFail['trusted-capture'], 'a refused approval that then failed teaches no lesson, while the Commander\'s own words still count');
  const hop = LE.passes(LE.runOutcome(Object.assign({}, base, { reason: 'error', lineHop: true })));
  A.eq(hop['failure-review'], false, 'QW19: a failed line hand-off is not failure-reviewed (its USER turn is the line\'s frame)');
  A.eq(LE.learningEligible(LE.runOutcome(Object.assign({}, base, { reason: 'error', lineHop: true })), 'failure-review').reason, 'line_hop', 'and the verdict names why');
}
// every pass needs a real-work run, and an unfinished run teaches nothing
{
  for (const [why, facts] of [['internal', { internal: true }], ['recovery', { recovery: true }], ['not_a_task', { task: false }], ['not_a_learning_run', { reflect: false }]]) {
    for (const kind of ['done', 'failed']) {
      const o = LE.runOutcome(Object.assign({}, base, KIND_FACTS[kind], facts));
      A.ok(PASSES.every(p => !LE.learningEligible(o, p).ok) && LE.learningEligible(o, 'reflection').reason === why, why + ' (' + kind + '): no pass learns');
    }
  }
  for (const facts of [{ reason: 'done', truncated: true }, { reason: 'done', clarifying: true }, { reason: 'empty' }, { reason: 'done', aborted: true }]) {
    const o = LE.runOutcome(Object.assign({}, base, facts));
    A.ok(PASSES.every(p => !LE.learningEligible(o, p).ok), 'no pass learns from ' + JSON.stringify(facts) + ' (' + o.kind + ')');
  }
  A.eq(LE.runOutcome(Object.assign({}, base, { reason: 'refusal' })).kind, 'failed', 'a provider refusal is a failure (the review decides separately whether it can read it)');
  A.eq(LE.learningEligible({ base: true, kind: 'done' }, 'scout').reason, 'unknown_pass', 'an unknown pass is refused, never waved through');
}

/* ---------- 2. every gate in runOnceCore reads the one predicate ---------- */
{
  const core = sidecarTopLevelFunction('runOnceCore');
  A.ok(core.length > 1000, 'runOnceCore sliced');
  const at = core.indexOf('const _learn = LearningEligibility.passes(LearningEligibility.runOutcome(');
  A.ok(at > 0, 'the run is classified once, through learning-eligibility.js');
  const decl = core.slice(at, core.indexOf('}));', at));
  for (const fact of ['denied: refusedAction(execution.toolTraceList())', 'tainted: !!execution.taintedBy()', 'quoted: quotedLearning', 'lineHop: _lineHop', 'aborted: signal.aborted', 'recovery: !!o.recovery', 'internal: !!internal'])
    A.ok(decl.indexOf(fact) >= 0, 'the outcome is built from the run\'s own fact: ' + fact);
  const gate = name => { const g = core.indexOf('const ' + name + ' = '); return g < 0 ? '' : core.slice(g, core.indexOf(';\n', g)); };
  const gates = { reflection: gate('_gateReflect'), study: gate('_gateStudy'), threadmine: gate('_gateThreadmine'), 'failure-review': gate('_gateFailReview') };
  for (const [pass, text] of Object.entries(gates)) {
    A.ok(text && text.indexOf("_learn['" + pass + "']") >= 0 || text.indexOf('_learn.' + pass + ' ') >= 0, pass + ' gate reads the predicate: ' + text.slice(0, 120));
    A.ok(!/_lineHop|refusedAction|_auxDone|_auxFail|learningTaint/.test(text), pass + ' gate keeps no private copy of the guards');
  }
  A.ok(/if \(_learn\['trusted-capture'\]\) \{\s*await captureTrustedLearning\(/.test(core), 'trusted capture is gated by the same predicate');
  A.ok(!/'reflection', 'failure-review', 'study', 'threadmine'\]/.test(core), 'the separate taint splice of the four transcript passes is gone (the predicate reads taint and quotes)');
  A.ok(core.indexOf('const _lineHop =') < at && core.indexOf('const quotedLearning =') < at, 'the facts the outcome reads are known before it is built');
  A.ok(core.indexOf("if (_learn['trusted-capture'])") > at && gates.reflection && core.indexOf('const _gateReflect = ') > at, 'and every reader comes after it');
}

A.report('learning-eligibility.matrix');
