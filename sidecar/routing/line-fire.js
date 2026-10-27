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
   Pure: no clock, no I/O. */
'use strict';

const FACT_MAX = 300;

function lineStopNote(res) {
  if (!res || !res.stopped) return '';
  return '\n\n⚠ the work line stopped early — ' + res.stopped + '.';
}

function lineFacts(line) {
  if (!line || typeof line !== 'object') return null;
  const facts = {};
  for (const k of ['stopped', 'unapproved', 'partial']) {
    if (line[k]) facts[k] = String(line[k]).slice(0, FACT_MAX);
  }
  return Object.keys(facts).length ? facts : null;
}

function foldLineIntoFire(state, line) {
  if (!state || !line || typeof line !== 'object') return state;
  const hops = Array.isArray(line.hops) ? line.hops.length : 0;
  if (String(line.text || '').trim()) state.buf = String(line.text);
  if (hops) state.buf = String(state.buf || '') + lineStopNote(line);
  else if (line.stopped && line.stopped !== 'stopped') state.buf = String(state.buf || '') + lineStopNote(line);
  if (typeof line.usd === 'number' && isFinite(line.usd)) state.usd = (Number(state.usd) || 0) + line.usd;
  state.line = lineFacts(line);
  return state;
}

module.exports = { lineStopNote, lineFacts, foldLineIntoFire };
