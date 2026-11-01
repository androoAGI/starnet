/* sidecar/routine-identity.js — WHO a routine run is and WHETHER it runs as a command, for BOTH ways a routine fires: the
   scheduled tick (cron-driver.js fireJob + index.js's cron runOnce wrapper) and Run Now (index.js handleCronRun). (quick win 31)

   Run Now is "test it now": it must be the scheduled fire, pressed by hand. It had drifted on three facts:
     · recipeId — a routine minted from a recipe carries it on every scheduled run row (provenance); Run Now's rows had none;
     · idempotencyScope — a retried/resumed run must not re-send a connector write it already made; the scheduled fire scopes
       that to job + fire time, Run Now passed no scope, so its writes were deduped only per run;
     · the COMMAND rule — a routine whose prompt starts with '/' runs the slash COMMAND, not a model turn, unless it carries a
       pre-check SCRIPT (the scheduled wrapper's `!opts.cronScript`); Run Now redirected every '/' prompt, script or not.
   One definition each, so the two paths cannot drift again.

     routineRunIdentity(job, firedAt) -> { cronJobId, cronJobName, recipeId?, idempotencyScope }
     runsAsCommand(promptText, script) -> bool */
'use strict';

function routineRunIdentity(job, firedAt) {
  const j = job || {};
  const out = {
    cronJobId: j.id,
    cronJobName: j.name || '',
    // IDEMPOTENCY SCOPE: the same fire retried/resumed must not re-send a connector write, but the NEXT fire of the same
    // routine legitimately may — so the scope is job + the fire's time (a Run Now press is its own fire)
    idempotencyScope: 'cron:' + String(j.id) + ':' + String(firedAt == null ? '' : firedAt)
  };
  // provenance spine (R3 meta bag -> durable run row): undefined for a plain routine
  const recipeId = j.meta && j.meta.recipeId;
  out.recipeId = recipeId ? recipeId : undefined;
  return out;
}

function runsAsCommand(promptText, script) {
  return String(promptText == null ? '' : promptText).charAt(0) === '/' && !script;
}

module.exports = { routineRunIdentity, runsAsCommand };
