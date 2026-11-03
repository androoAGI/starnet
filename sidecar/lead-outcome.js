/* sidecar/lead-outcome.js — the LEAD run's outcome at a decision runOnceCore takes itself (typed-outcomes lane, the unpark,
   2026-10-30).

   runOnceCore decides from how its run ended at seams the outward outcome sink (RunOutcome.sink: sidecar/index.js outcomeSink)
   cannot answer in time. The Task Brief settle, the typed postconditions and the on_session_end hook run while the lead's 'done'
   end is still BUFFERED (loopEmit holds it until the image / Task Brief / postcondition assessment, so the sink has not stamped it
   yet), and the quest sweep and the aux passes run after runStore.record has CONSUMED the sink's endedOutcomes entry. Each of them
   read the loop's bare end word instead, so a reply the provider cut (finishReason 'length' / 'content_filter') completed a quest,
   completed a Task Brief, graded postconditions completed_verified and reached a user's hook as 'done'.

   So each decision reads the run's canonical LEAD facts here, by the resolver's own rule (frontend/app/runoutcome.js ofEnd): an
   error the run itself raised after its loop ended (an image task that produced no image) outranks the provider's finishReason,
   which outranks the loop's end word; no end at all is no_terminal_outcome, never done. The facts are the lead's own loop result and
   its own late error, so a child's terminal (a delegated worker's end or error, forwarded onto the lead's stream) never settles or
   rewrites the lead.

   of({ reason, finishReason, failureCode, clarifying, ownError }) -> { outcome, failureCode, ok, reason }
     reason is the word a REASON-keyed reader gets (RunOutcome.reasonOf's rule, with the own error read too): 'done' only for a
     SUCCEEDED run; a 'done' end reads 'cut_short', 'clarifying' (it asked the Commander a question) or 'error' (its own error
     outranked it); no end at all reads 'error'. Any other reason is its own while it names the outcome (a refused 'error' reads 'refusal').
   ofResult(loopResult, { clarifying, ownError }) — the same, over runOnceCore's loop result.
   Pure: facts in, outcome out — no clock, no IO. */
'use strict';
const RunOutcome = require('../frontend/app/runoutcome.js');

function of(facts) {
  const f = facts || {};
  const reason = f.reason == null ? '' : String(f.reason);
  const own = f.ownError && typeof f.ownError === 'object' ? f.ownError : null;
  const end = reason ? { reason, finishReason: f.finishReason, failureCode: f.failureCode, clarifying: f.clarifying === true } : null;
  const o = RunOutcome.ofEnd(end, own);
  // the REASON word by the resolver's own rule (RunOutcome.reasonOf over the settled outcome): 'done' only for a SUCCEEDED run, and a word the
  // outcome contradicts reads the outcome's own end word (review 9.2: a provider's safety block, reason 'error' refused, kept the failure's 'error')
  const word = RunOutcome.reasonOf({ reason: reason || 'done', outcome: o.outcome });
  return { outcome: o.outcome, failureCode: o.failureCode, ok: o.ok, reason: word };
}

function ofResult(result, opts) {
  const r = result && typeof result === 'object' ? result : null;
  const x = opts || {};
  return of({ reason: r ? r.reason : '', finishReason: r ? r.finishReason : undefined, failureCode: r ? r.failureCode : undefined,
    clarifying: x.clarifying === true, ownError: x.ownError || null });
}

module.exports = { of, ofResult };
