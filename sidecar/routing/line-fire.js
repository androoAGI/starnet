/* sidecar/routing/line-fire.js — what a finished WORK LINE leaves on the fire that started it (quick win 25).

   A line can end short of its OUTBOX (a stage failed, a hop was refused, the stage ceiling ran out), can come out of its
   JOINER partial, or can leave a review loop UNAPPROVED (GitHub #122). The channel hub has always said the first one in the
   reply (chain.stopNote) and handed all three to its outcome hook. The two ROUTINE paths — the scheduled fire
   (cron-driver.js) and Run Now (index.js handleCronRun) — took only the line's text and spend: a routine whose line died
   at stage two delivered stage one's answer as if the whole line had run, with nothing on its record to say otherwise.

     lineStop(code, facts)       -> { code, why }   THE TYPED LINE STOP (line-job-runner, 2026-11-03): every place a walk stops names one
        code from RunOutcome.LINE_STOPS and says it in the ONE sentence made here — chain.js's walk (out.stop beside the legacy
        out.stopped words), the step-through test (session.stop), and the entries that settle a job. facts: { agent (who the stop is
        about, as the surface names it: an agent id on the chain, a display name in the step test), error (that stage's own words),
        target, maxHops, maxUsd, maxUsdPerDay, join, loop (the gate a hold is at) and reason (why it holds: blocked | missing_verdict |
        spent), barrier ('fanout' | 'join'), partial, handOn (the
        pre-hop empty crate), unarmed (no line is armed any more), why (a refusal's own words: refused, and not_steppable at start) }.
        Each code keeps the words its stop always had, except one: a stage that did not finish (cut short, a spending or step limit, a
        question, interrupted, no end) reads '<agent> did not finish: <why>', never '<agent> failed' (a limit is not a failure).
     hopStopCode(result)         -> the stop code a HOP's result names (line-runner.js hopRunner stamps stopCode from the hop's own
        outcome; a runAgent that says only error / stopped / nothing is read as chain.js always read it), or null when it handed on
     lineStopNote(line)          -> '' | '\n\n⚠ the work line stopped early — <why>.'   (the ONE wording; chain.js uses it)
     lineFacts(line)             -> { stopped?, stopCode?, unapproved?, partial? } | null   (bounded strings; stopCode additive)
     foldLineIntoFire(state, line, handed?) -> state   the fire's reply/spend/facts after its line, exactly as the hub folds it:
        · the line's answer replaces stage one's; a line that ran hops and stopped says so under its answer. `handed` is the text the
          line was seeded with (stage one's TERMINAL text, line-runner.js): a line that ran no hop and left that text as it was keeps
          the reply stage one streamed (its host note or steer echo were said to the person, never handed on);
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
const Verdict = require('./verdict.js');   // a hold's one sentence (heldWhy)

const FACT_MAX = 300;

/* ---- THE TYPED LINE STOP: one sentence per code (header). Today's words, byte for byte, except stage_incomplete. ---- */
const named = f => String(f.agent || 'a stage');
const detail = f => (f.error ? ': ' + String(f.error) : '');
const dollars = v => '$' + (Number(v) || 0).toFixed(2);
const STOP_WORDS = Object.freeze({
  // the LINE BUDGET (chain.js preHopStop; the step-through test reads the same guard). With no budget named it is the walk's own guard
  hop_limit: f => (f.maxHops != null ? 'the line is longer than ' + f.maxHops + ' stages — raise max stages in the INBOX’s LINE BUDGET' : 'the line ran past its hop ceiling'),
  usd_limit: f => 'the line reached its ' + dollars(f.maxUsd) + ' limit',
  day_limit: f => 'the line reached its ' + dollars(f.maxUsdPerDay) + ' daily limit',
  stage_incomplete: f => named(f) + ' did not finish' + detail(f),
  stage_failed: f => named(f) + ' failed' + detail(f),
  stage_empty: f => named(f) + (f.handOn ? ' produced no output to hand on' : ' returned nothing'),
  loops_back: f => 'the line loops back to ' + String(f.target || named(f)),
  // plain language, no ids, no belt vocabulary — the one thing the Commander can act on (2026-10-09 P0): the job belongs to another
  // line, and work crosses to another line only by SEND TO (2026-10-10)
  wrong_line: f => 'this job started on a different line, so it stopped at ' + named(f) + ' — a line hands its work to another line only by SEND TO (drag its OUTBOX onto that line’s INBOX)',
  no_outbox: f => (f.unarmed ? 'no work line is armed any more — the line ends at this bay' : 'the belt from ' + named(f) + ' does not reach the OUTBOX — the line ends at this bay'),
  partial_join: f => 'the joiner sent on without every branch' + (f.partial ? ' (' + String(f.partial) + ')' : ''),
  joiner_lost: f => 'the joiner at ' + String(f.join || 'the join') + ' lost its branches',
  stopped: f => (f.agent ? named(f) + ' was stopped' : 'stopped'),
  station_fault: f => (f.agent ? named(f) + ' failed: ' : '') + String(f.error || 'the station hit an internal fault and stopped this run'),
  blocked: f => Verdict.heldWhy(f.loop, f.reason),   // reason: 'blocked' (default) | 'missing_verdict' | 'spent' — the three a hold has
  // the step-through test carries one crate at a time (its own refusal at START says it in the compiled topology's words: f.why)
  not_steppable: f => (f.why ? String(f.why) : f.barrier === 'join'
    ? 'this line meets a joiner here — the step-through test carries one crate at a time, so it stops before the join (use SEND A REAL JOB to prove a joined line)'
    : 'this line fans out into parallel branches here — the step-through test carries one crate at a time, so it stops before the split (use SEND A REAL JOB to prove a fan-out line)'),
  refused: f => String(f.why || 'the line refused this job before it ran'),
  restart: f => 'the sidecar restarted while ' + String(f.agent || 'a dock') + ' was working on this step — that run died with it and its result was lost'
});
function lineStop(code, facts) {
  const c = RunOutcome.isLineStop(code) ? code : 'stage_failed';
  return { code: c, why: STOP_WORDS[c](facts && typeof facts === 'object' ? facts : {}) };
}

// the codes a HOP can end with (line-runner.js hopVerdict): the rest are the walk's own
const HOP_STOPS = new Set(['day_limit', 'stage_incomplete', 'stage_failed', 'stage_empty', 'stopped', 'station_fault']);
function hopStopCode(r) {
  const x = r && typeof r === 'object' ? r : {};
  const coded = HOP_STOPS.has(x.stopCode) ? x.stopCode : null;
  if (!x.error && String(x.text || '').trim() && !coded) return null;   // the stage handed its work on
  if (x.stopped) return 'stopped';
  if (coded && coded !== 'stopped') return coded;
  return x.error ? 'stage_failed' : 'stage_empty';
}

// A host admission stop carries its already-proved limit and words. Never infer it from provider text.
function hopStop(r, facts) {
  const code = hopStopCode(r);
  if (!code) return null;
  return r && r.stop && r.stop.code === code ? { code, why: String(r.stop.why || '') } : lineStop(code, facts);
}

function lineStopNote(res) {
  if (!res || !res.stopped) return '';
  const why = res.stop && typeof res.stop.why === 'string' ? res.stop.why : String(res.stopped);
  /* A HELD JOB (line-hold lane, S3): the walk parked at a gate and its job is saved as held (line-runner.js sets res.held after the
     verified write). It says so, and where the person decides: the job in WORKFLOWS. A hold that could not be saved says why in `why`
     itself (res.stop.why, the terminal stop's own sentence) and reads as every other early stop. */
  if (res.held && typeof res.held === 'object') return '\n\n⏸ the work line paused — ' + why + '. It is saved for a person to decide: open ' + (res.held.jobId ? 'job ' + String(res.held.jobId) + ' ' : 'the job ') + 'in WORKFLOWS.';
  // a line SOMEONE STOPPED (res.halted / code 'stopped', routing/chain.js) is said as a stop, never as a stage that failed (review r7)
  if (res.halted || (res.stop && res.stop.code === 'stopped')) return '\n\n■ the work line was stopped before it finished' + (why !== 'stopped' ? ' — ' + why : '') + '.';
  return '\n\n⚠ the work line stopped early — ' + why + '.';
}

function lineFacts(line) {
  if (!line || typeof line !== 'object') return null;
  const facts = {};
  for (const k of ['stopped', 'unapproved', 'partial', 'blocked']) {   // blocked (additive): a reviewer's VERDICT: blocked held the job
    if (line[k]) facts[k] = String(line[k]).slice(0, FACT_MAX);
  }
  // (additive) the stop's code: a chain result's line.stop, or facts already folded (cron-store re-reads the fire's facts)
  const code = line.stop && typeof line.stop === 'object' ? line.stop.code : line.stopCode;
  if (facts.stopped && RunOutcome.isLineStop(code)) facts.stopCode = code;
  if (line.halted) facts.halted = true;   // (additive, review r7) someone STOPPED the line: RunOutcome.ofLine settles its fire 'stopped'
  return Object.keys(facts).length ? facts : null;
}

function foldLineIntoFire(state, line, handed) {
  if (!state || !line || typeof line !== 'object') return state;
  const hops = Array.isArray(line.hops) ? line.hops.length : 0;
  const unchanged = !hops && typeof handed === 'string' && String(line.text) === handed;
  if (String(line.text || '').trim() && !unchanged) state.buf = String(line.text);
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

module.exports = { lineStop, hopStopCode, hopStop, lineStopNote, lineFacts, foldLineIntoFire, hopError, lineDelivered };
