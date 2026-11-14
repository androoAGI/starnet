'use strict';
/* sidecar/delegation-hint.js — WHAT A WORKER COSTS (cost audit W2.9, 2026-11-14).

   THE COST. A worker a lead dispatches or spawns is a whole run of its own: its own prompt, its own tool list, its own
   requests. On the audit's rig a delegated turn sent 3.2x (foreground) to 4.4x (background) the request bytes of the same
   turn done alone. The team note tells every run that holds team.dispatch to DELEGATE; only the Overseer's variant also
   says "Handle simple work directly", and neither says a worker is paid for. A crew agent the Commander chats with
   directly is a lead too (index.js /api/run sets lead for every browser run), and gets the DELEGATE line with no
   counterweight at all.

   THE LINE. One bullet, the same bytes in both variants of the team note (the Overseer coordinating the station's crew,
   and any other run that holds team.dispatch: a crew agent chatted with directly, a channel or routine lead). It sits
   right after the two bullets that offer workers (YOUR TEAM, SPAWN). It states the cost, asks for simple or single-step
   parts of the run's OWN job to be done directly, and then says what it does not limit:
     - anything the Commander, the agent's standing orders or its bay's brief ask to be handed off;
     - parallel, long-running or specialist work (the uses the notes around it already recommend);
     - a line: the other bays keep their own part. A line stage is told elsewhere never to dispatch the later bays' work
       (projectbless.js lineStageTeam); "do it yourself" must not read as "do the next bay's part too".
   It is a hint, never a gate: nothing is withheld, no call is refused, no count is kept. Static: no per-run value, so it
   sits in the cached prefix like the note around it. The crewless note (no crew to dispatch to) does not carry it.

   THE SWITCH. STARNET_DELEGATION_HINT, read in one place (index.js delegationHintOn, through ENV()). '1' is on. Unset,
   blank, '0' and every other value are off, and off adds nothing: line() returns '' and the note is byte-identical to
   before. Off by default until an A/B on real team tasks shows leads do not start under-delegating.
   Pure: no environment, no clock. */

// the switch's VALUE as ENV('DELEGATION_HINT') read it: only '1' turns the line on
function on(value) {
  return typeof value === 'string' && value.trim() === '1';
}

const LINE = '\n• WHAT A WORKER COSTS: each worker you dispatch or spawn is a separate full run billed on top of yours, so do a simple or single-step part of your own job yourself. '
  + 'Still delegate whenever the Commander, your standing orders or your bay\'s brief ask for it, and for parallel, long-running or specialist work; a line\'s other bays keep their own part.';

// What the team note appends after its SPAWN bullet. enabled: delegationHintOn().
function line(enabled) {
  return enabled === true ? LINE : '';
}

module.exports = { on, line, LINE };
