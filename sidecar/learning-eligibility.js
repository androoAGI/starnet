/* sidecar/learning-eligibility.js — ONE rule for which runs may teach the station (memory-truth-1027; rel#7, quick win 19).

   FIVE passes learn from a finished run: reflection, study and thread mining read a DONE run's transcript; the failure
   review reads a FAILED run's transcript; trusted capture reads only the Commander's own directive, captured by the host
   before the loop ran. Each pass used to carry its own copy of the guards, and the copies drifted: a run whose approval
   was refused stopped reaching reflection (2026-10-17) but still reached study and thread mining; a line hand-off
   stopped reaching reflection, study and thread mining (2026-09-30) but still reached the failure review; tainted and
   quoted material was removed from the candidate list in a separate loop after the gates. The same run could teach one
   pass and not another for reasons nobody chose.

   runOutcome(facts) classifies the run ONCE — kind done | failed | denied | cancelled | unfinished, plus the modifiers
   tainted (outside content), quoted (owner-pasted material), lineHop (a work line's hand-off frame) — and
   learningEligible(outcome, pass) is the one predicate every gate reads:
     · transcript passes (reflection, study, threadmine on DONE; failure-review on FAILED): never on a denied, cancelled
       or unfinished run, never on a tainted, quoted or line-hop transcript. A refused action is not a lesson.
     · trusted-capture reads only the directive the host captured, so outside content or quoted material in the
       transcript does not withhold it, and the Commander's explicit statement still counts when they refused an
       approval or the run failed. A line hand-off is never the Commander speaking; a stopped run teaches nothing.
   Every pass needs a real-work run: o.reflect, a task, not internal self-talk, not a recovery continuation.
   Pure: facts in, verdicts out — no clock, no IO. */
'use strict';

// which run-end reasons are a FAILURE worth a lesson (failreview.js REVIEW_REASONS — one table, read from there)
const Failreview = require('./failreview.js');

const KINDS = ['done', 'failed', 'denied', 'cancelled', 'unfinished'];
const MODIFIERS = ['tainted', 'quoted', 'lineHop'];
// what each pass reads, and which outcome it learns from
const PASSES = {
  reflection: { reads: 'transcript', on: ['done'] },
  study: { reads: 'transcript', on: ['done'] },
  threadmine: { reads: 'transcript', on: ['done'] },
  'failure-review': { reads: 'transcript', on: ['failed'] },
  'trusted-capture': { reads: 'directive', on: ['done', 'failed', 'denied'] }
};

/* runOutcome(facts) -> { kind, tainted, quoted, lineHop, base, why }
   facts: { reason, aborted, recovery, truncated, clarifying, denied, tainted, quoted, lineHop, reflect, task, internal } */
function runOutcome(facts) {
  const f = facts || {};
  const reason = String(f.reason == null ? '' : f.reason);
  let kind;
  if (f.aborted || reason === 'cancelled') kind = 'cancelled';                         // the Commander stopped it
  else if (reason === 'done' && !f.truncated && !f.clarifying) kind = 'done';
  else if (Failreview.reviewableReason(reason)) kind = 'failed';                     // error · max_iters · budget · refusal
  else kind = 'unfinished';                                                          // truncated, a clarifying question, empty
  // a refused approval (reflect.refusedAction: a Deny, an unanswered card, an unattended default-deny) makes a finished
  // or failed run DENIED: its work is not what was asked for
  if (f.denied && (kind === 'done' || kind === 'failed')) kind = 'denied';
  const why = !f.reflect ? 'not_a_learning_run' : !f.task ? 'not_a_task' : f.internal ? 'internal' : f.recovery ? 'recovery' : '';
  return { kind, tainted: !!f.tainted, quoted: !!f.quoted, lineHop: !!f.lineHop, base: !why, why: why || null };
}

/* learningEligible(outcome, pass) -> { ok, reason } — the ONE predicate. reason names the first rule that refused. */
function learningEligible(outcome, pass) {
  const o = outcome || {};
  const p = PASSES[pass];
  if (!p) return { ok: false, reason: 'unknown_pass' };
  if (!o.base) return { ok: false, reason: o.why || 'not_a_learning_run' };
  if (o.lineHop) return { ok: false, reason: 'line_hop' };   // the hand-off frame is never the Commander's words
  if (p.on.indexOf(o.kind) < 0) return { ok: false, reason: o.kind === 'cancelled' || o.kind === 'denied' || o.kind === 'unfinished' ? o.kind : 'not_' + p.on[0] };
  if (p.reads === 'transcript') {
    if (o.tainted) return { ok: false, reason: 'tainted' };
    if (o.quoted) return { ok: false, reason: 'quoted' };
  }
  return { ok: true, reason: 'eligible' };
}

// every pass's verdict for one run, plus the kind (carried onto the proposals it raises)
function passes(outcome) {
  const out = { kind: outcome && outcome.kind };
  for (const name of Object.keys(PASSES)) out[name] = learningEligible(outcome, name).ok;
  return out;
}

module.exports = { KINDS, MODIFIERS, PASSES, runOutcome, learningEligible, passes };
