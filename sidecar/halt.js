/* sidecar/halt.js — the E-STOP kill logic, factored out of the host so it is unit-testable.
   killAll aborts EVERY in-flight run in one call: the browser runs (a Map runId -> AbortController) and the
   messaging-hub runs (a Map chatId -> { abort, superseded }). MULTIPLE hub maps may be passed (Telegram AND
   Discord share the same hub shape) — every trailing argument is treated as a hub inflight map. Hub runs are
   marked `superseded` BEFORE aborting so the hub does not deliver their now-stale partial reply after the kill
   (mirrors how the hub supersedes a run when a newer message arrives). Tolerant of null/absent maps and of an
   individual abort throwing — an E-STOP must never itself throw. Returns the number of runs aborted.
   Hub runs are ALSO marked `halted`, which is what lets the hub tell that chat it was stopped on purpose
   rather than returning the same silence a supersede earns. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).halt = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function killAll(runs, ...hubInflights) {
    let halted = 0;
    if (runs && typeof runs.values === 'function') {
      for (const ac of runs.values()) { try { if (ac && typeof ac.abort === 'function') ac.abort(); halted++; } catch (_) { halted++; } }
    }
    for (const hubInflight of hubInflights) {
      if (!hubInflight || typeof hubInflight.values !== 'function') continue;
      for (const rec of hubInflight.values()) {
        try {
          // `halted` alongside `superseded`: both must silence this run's now-stale partial, but they mean
          // different things downstream. A supersede means a NEWER message owns the conversation and is about
          // to answer, so silence is correct; an E-STOP means nothing else is coming, and on a phone (no floor,
          // no browser, no other signal) silence made a deliberate stop byte-identical to a crashed bot.
          if (rec) { rec.superseded = true; rec.halted = true; if (rec.abort && typeof rec.abort.abort === 'function') rec.abort.abort(); }
        } catch (_) { /* an E-STOP must not throw */ }
        halted++;
      }
    }
    return halted;
  }

  /* markFaulted(...hubInflights) — the stop about to land is the station's OWN process-fault containment, never the Commander's
     E-STOP (wave 2 repair, conveyor-backend-08): call it on the same hub maps right BEFORE killAll. It stops nothing itself; it
     only sets `faulted` on each record, so whoever reads `halted` (the hub's chat notice, the step test, the hand-off records)
     names the fault instead of an E-STOP nobody pressed. Tolerant like killAll; returns the number of records marked. */
  function markFaulted(...hubInflights) {
    let marked = 0;
    for (const hubInflight of hubInflights) {
      if (!hubInflight || typeof hubInflight.values !== 'function') continue;
      for (const rec of hubInflight.values()) { if (rec && typeof rec === 'object') { rec.faulted = true; marked++; } }
    }
    return marked;
  }

  /* killStopHandles(stopHandles) — E-STOP's reach into every run runOnce drives by its id (index.js runStopHandles: a
     routine fire, a hop, a line trigger, the step test, a channel hub, /v1). Those runs are not in the browser `runs`
     map, so killAll(runs, …) never reached the ones no hub map holds (QA 0930: E-STOP said 0 stopped and the run kept
     spending). Aborts EVERY handle and returns how many of those runs nothing else had stopped yet: a handle carries
     its run's combined signal (`runSignal` = its owner's signal OR the handle, set by runOnceTracked), so a run its
     owner's abort already reached reads aborted there and is not counted twice. Call it AFTER the other kills, so
     the count adds only the runs they missed. Tolerant like killAll: an abort that throws is handed to onError (the
     host's failNote), is not counted as a stop, and never stops the rest. */
  function killStopHandles(stopHandles, onError) {
    let fresh = 0;
    if (!stopHandles || typeof stopHandles.values !== 'function') return 0;
    for (const kc of Array.from(stopHandles.values())) {
      if (!kc || typeof kc.abort !== 'function') continue;
      const sig = kc.runSignal || kc.signal;
      const live = !(sig && sig.aborted);
      let threw = false;
      try { kc.abort(); } catch (e) { threw = true; if (typeof onError === 'function') onError(e); }
      if (live && !threw) fresh++;
    }
    return fresh;
  }

  return { killAll, markFaulted, killStopHandles };
});
