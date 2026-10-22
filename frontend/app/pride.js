/* AGENT OS — pride.js : the LIFETIME STATION RECORD engine (Game session, Phase G3a / Layer 6).

   Pure, durable fold of the station's WHOLE-LIFETIME record — the counters that grow across every
   session and don't reset at app-open the way floorstats.js does. This is the "pride" half of the meta
   loop: a beginner reopens the app weeks in and sees the colony's real track record, not a now-only HUD.

   HONESTY RULES (the floorstats philosophy, Part 4 laws):
     • Every counter is a fold of REAL harness events — a completed run, a delivered work-item, a fired
       routine, real elapsed run time. Nothing is estimated, padded, or a fabricated "hours saved".
     • A counter with NO samples yet reports known:false so the surface shows "—" instead of a made-up 0-as-real
       (same rule ctxgauge.js / floorstats.js apply). tasks/deliverables/routines each have their own known flag.
     • "station founded" = the first-boot timestamp, stamped ONCE and never moved (monotonic like the
       return-ritual heartbeat) — the honest birthday of the colony.
     • total agent-work minutes = the SUM of real run durations (agent.run.start paired to agent.run.end by
       runId, injected wall-clock). A run with no matching start contributes nothing — never guessed.

   Pure + dependency-free (no DOM / rng / ambient clock — the caller injects nowMs, like floorstats.onEvent):
   a `Pride` global in the browser, module.exports under node — unit-testable headless. The thin browser
   wiring + the durable localStorage key live in pridestore.js (cloning returnstore.js). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Pride = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPEN_CAP = 200;   // runId ring for in-flight starts (a start with no end can't leak unbounded)

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function nn(v) { return Math.max(0, Math.floor(num(v))); }
  function str(v) { return v == null ? '' : String(v); }

  // hydrate a persisted blob (or null/corrupt) into a sane, monotonic-safe state object.
  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const open = (s.open && typeof s.open === 'object' && !Array.isArray(s.open)) ? s.open : {};
    const cleanOpen = {};
    let n = 0;
    for (const k of Object.keys(open)) { if (n++ >= OPEN_CAP) break; const t = num(open[k]); if (t > 0) cleanOpen[k] = t; }
    return {
      v: 1,
      foundedAt: Math.max(0, num(s.foundedAt)),   // 0 = not yet founded (stamped on the first real event)
      tasks: nn(s.tasks),                          // lifetime clean-completed runs (agent.run.end reason 'done')
      deliverables: nn(s.deliverables),            // lifetime work-items delivered (workitem.delivered)
      routines: nn(s.routines),                    // lifetime scheduled-routine fires (cron.fire)
      workMs: Math.max(0, num(s.workMs)),          // lifetime sum of REAL run durations (start→end, ms)
      sawTask: !!s.sawTask,                         // per-counter "has a real sample" flags — drive the honest "—"
      sawDeliverable: !!s.sawDeliverable,
      sawRoutine: !!s.sawRoutine,
      sawWork: !!s.sawWork,
      open: cleanOpen                              // runId -> run.start wall-clock, paired on run.end for duration
    };
  }

  // stamp the founding instant exactly once (the first REAL event the station ever folds). Monotonic — a later
  // event never moves it. nowMs is the caller's injected wall-clock (Date.now()); a missing/garbage clock is ignored.
  function found(s, nowMs) {
    const t = num(nowMs);
    if (s.foundedAt === 0 && t > 0) s.foundedAt = t;
  }

  /* fold ONE real event into the lifetime record (returns a NEW state — pure). name = the U.bus event name,
     p = its payload, nowMs = the caller's injected wall-clock for the founding stamp + run-duration pairing.
     Unknown names are folded through untouched (the caller can point the firehose at it) — but they do NOT
     found the station, so an idle heartbeat event never fakes a birthday before the first real outcome. */
  function fold(state, name, p, nowMs) {
    const s = hydrate(state);
    p = p || {};
    if (name === 'agent.run.start') {
      const id = str(p.runId); const t = num(nowMs);
      if (id && t > 0) { s.open[id] = t; found(s, nowMs); }
      // trim the in-flight ring oldest-first so a long uptime with dropped ends can't grow unbounded
      const ks = Object.keys(s.open);
      if (ks.length > OPEN_CAP) { for (let i = 0; i < ks.length - OPEN_CAP; i++) delete s.open[ks[i]]; }
    } else if (name === 'agent.run.end') {
      found(s, nowMs);
      if (p.reason === 'done') { s.tasks += 1; s.sawTask = true; }   // a clean deliverable-banking run — the lifetime task count
      // pair to its start for a REAL duration; an unmatched end contributes nothing (never guessed)
      const id = str(p.runId); const t = num(nowMs);
      if (id && s.open[id] && t > 0) {
        const d = t - s.open[id];
        if (d > 0) { s.workMs += d; s.sawWork = true; }
        delete s.open[id];
      }
    } else if (name === 'workitem.delivered' && p.box !== 'line-output') {
      s.deliverables += 1; s.sawDeliverable = true; found(s, nowMs);
    } else if (name === 'cron.fire') {
      s.routines += 1; s.sawRoutine = true; found(s, nowMs);
    }
    return s;
  }

  // render-agnostic snapshot for the STATION RECORD surface. Honest unknowns: a counter with no real sample
  // yet reports known:false so the UI shows "—". foundedAt is passed through raw (null when unfounded) so the
  // caller formats the date in its own locale. workMinutes is floored whole minutes of REAL summed run time.
  function snapshot(state) {
    const s = hydrate(state);
    const workMinutes = Math.floor(s.workMs / 60000);
    return {
      founded: s.foundedAt > 0,
      foundedAt: s.foundedAt > 0 ? s.foundedAt : null,
      tasks: s.tasks, tasksKnown: !!s.sawTask,
      deliverables: s.deliverables, deliverablesKnown: !!s.sawDeliverable,
      routines: s.routines, routinesKnown: !!s.sawRoutine,
      workMinutes: workMinutes, workKnown: !!s.sawWork
    };
  }

  return { hydrate, fold, snapshot, OPEN_CAP };
});
