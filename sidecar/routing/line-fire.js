/* sidecar/routing/line-fire.js — what a finished WORK LINE leaves on the fire that started it (quick win 25).

   A line can end short of its OUTBOX (a stage failed, a hop was refused, the stage ceiling ran out), can come out of its
   JOINER partial, or can leave a review loop UNAPPROVED (GitHub #122). The channel hub has always said the first one in the
   reply (chain.stopNote) and handed all three to its outcome hook. The two ROUTINE paths — the scheduled fire
   (cron-driver.js) and Run Now (index.js handleCronRun) — took only the line's text and spend: a routine whose line died
   at stage two delivered stage one's answer as if the whole line had run, with nothing on its record to say otherwise.

     lineStopNote(line)          -> '' | '\n\n⚠ the work line stopped early — <why>.'   (the ONE wording; chain.js uses it)
     lineFacts(line)             -> { stopped?, unapproved?, partial? } | null            (bounded strings)
     foldLineIntoFire(state, line) -> state   the fire's reply/spend/facts after its line, exactly as the hub folds it:
        · the line's answer replaces stage one's; a line that ran hops and stopped says so under its answer;
        · a line that never got going (no hops) and stopped for a reason other than the Commander's own STOP says so too;
        · the line's spend is added to the entry run's; state.line carries the facts for the fire's durable record.
     hopError(hop, stoppedSaid)  -> string | null   the error a line HOP hands the chain (typed-outcomes): its own raised error, its
        STOP, or its OWN end read through RunOutcome — null only for a hop whose run SUCCEEDED. Every hop runner returns it (the
        routine's scheduled seam and Run Now in index.js, the channel hub, the step-through test).
     lineDelivered(line)         -> boolean   did the work line (when one ran) deliver the WHOLE job (review 4.3)? A line that STOPPED short
        (a failed, refused or empty stage, a hop or $ ceiling, a loop back, a STOP, a reviewer's hold) or whose JOINER sent on without
        every branch (partial) delivered no finished job, so the crate that entered it never rides to the OUTBOX — the ONE crate rule
        of the channel hub, the scheduled fire and Run Now (cron-driver fireOutcome .delivered), as chain.js's own line-output receipt,
        the trigger and SEND TO runners and the sample route already hold it. An UNAPPROVED loop reached its OUTBOX (GitHub #122: said,
        never held). No line = the entry run's own outcome decides. The fire's RECORD is unchanged: a stopped line still records the
        entry run's outcome with its stop facts (quick win 25); only the crate's delivery reads the line — except a line SOMEONE STOPPED
        (facts.halted, review r7) or a reviewer BLOCKED: RunOutcome.ofLine settles that fire 'stopped' / 'blocked'.
   Pure: no clock, no I/O. */
'use strict';
const RunOutcome = require('../../frontend/app/runoutcome.js');

const FACT_MAX = 300;

function lineStopNote(res) {
  if (!res || !res.stopped) return '';
  // a line SOMEONE STOPPED (res.halted, routing/chain.js) is said as a stop, never as a stage that failed (review r7)
  if (res.halted) return '\n\n■ the work line was stopped before it finished' + (String(res.stopped) !== 'stopped' ? ' — ' + res.stopped : '') + '.';
  return '\n\n⚠ the work line stopped early — ' + res.stopped + '.';
}

function lineFacts(line) {
  if (!line || typeof line !== 'object') return null;
  const facts = {};
  for (const k of ['stopped', 'unapproved', 'partial', 'blocked']) {   // blocked (additive): a reviewer's VERDICT: blocked held the job
    if (line[k]) facts[k] = String(line[k]).slice(0, FACT_MAX);
  }
  if (line.halted) facts.halted = true;   // (additive, review r7) someone STOPPED the line: RunOutcome.ofLine settles its fire 'stopped'
  return Object.keys(facts).length ? facts : null;
}

function foldLineIntoFire(state, line) {
  if (!state || !line || typeof line !== 'object') return state;
  const hops = Array.isArray(line.hops) ? line.hops.length : 0;
  if (String(line.text || '').trim()) state.buf = String(line.text);
  // a line stopped before its first hop (line.halted, 'stopped') says so too (review r7): its fire is 'stopped', and stage one's draft
  // never goes out as a clean, complete result
  if (hops || line.halted) state.buf = String(state.buf || '') + lineStopNote(line);
  else if (line.stopped && line.stopped !== 'stopped') state.buf = String(state.buf || '') + lineStopNote(line);
  if (typeof line.usd === 'number' && isFinite(line.usd)) state.usd = (Number(state.usd) || 0) + line.usd;
  state.line = lineFacts(line);
  return state;
}

/* chain.js hands a hop's text on (workitem.delivered, the next dock, the OUTBOX) only when the hop returned no error. A hop's run that
   ended without SUCCEEDING raises no agent.run.error — a reply the provider cut ('done' + finishReason 'length'), a spending or step
   limit, an empty reply, a question nobody on the line can answer — and a run that never reported its end proves nothing: each is a
   stage that did not finish, so its partial text is never passed on as finished work. hop: { errMsg, stopped, end } where end is the
   hop's OWN agent.run.end (a worker it delegated to forwards its end under its own runId — never the hop's). */
function hopError(hop, stoppedSaid) {
  const h = hop || {};
  if (h.errMsg) return String(h.errMsg);
  if (h.stopped) return stoppedSaid || 'stopped by you';
  const o = RunOutcome.ofEnd(h.end && typeof h.end === 'object' ? h.end : null, null);
  if (o.ok) return null;
  if (o.outcome === 'failed') return o.failureCode === RunOutcome.NO_TERMINAL ? 'its run never reported how it ended' : 'its run failed (' + o.failureCode + ')';
  return RunOutcome.line(o);
}

// the work line delivered the whole job (header): never stopped short, never a partial join. line: chain.advance's result or lineFacts
function lineDelivered(line) {
  return !line || typeof line !== 'object' || (!line.stopped && !line.partial);
}

module.exports = { lineStopNote, lineFacts, foldLineIntoFire, hopError, lineDelivered };
