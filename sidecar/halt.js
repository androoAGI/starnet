/* sidecar/halt.js — the E-STOP kill logic, factored out of the host so it is unit-testable.
   killAll aborts EVERY in-flight run in one call: the browser runs (a Map runId -> AbortController) and the
   messaging-hub runs (a Map chatId -> { abort, endReason }). MULTIPLE hub maps may be passed (Telegram AND
   Discord share the same hub shape) — every trailing argument is treated as a hub inflight map. Tolerant of
   null/absent maps and of an individual abort throwing — an E-STOP must never itself throw. Returns the number
   of runs aborted.

   ONE endReason FOR A WITHDRAWN RUN (channel-delivery-ledger S5). A run taken back before it answered carries one
   word on its record: 'superseded' (a newer message took the chat), 'stopped' (the owner's /stop or plain "stop"),
   'halted' (E-STOP) or 'faulted' (the station's own fault containment). The hub writes the first two and this file
   the last two, always BEFORE the abort, so the hub never delivers the now-stale partial reply after the kill. The
   FIRST one written stands (markEnd): a run has one ending, and that is what the chat is told. Readers use endOf(rec)
   and nothing else; any reason at all means "deliver nothing of this run and start nothing for it". Four flags with
   three writers used to say this, grown from one flag that carried two meanings (bug 600f4982). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).halt = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // a failure it swallows is noted (failopen.js) where the module system can reach it
  const failNote = (function () {
    if (typeof require !== 'function') return null;
    try { return require('./failopen.js').note; } catch (e) { return null; }
  })();
  // why this withdrawn run ended, or null while it is still the live run
  function endOf(rec) { return (rec && rec.endReason) || null; }
  /* the first writer wins; true when this call is the one that wrote it. A record that carries onEnd(reason) (a channel
     hub's run: its message's receipts settle where the decision is made, so a crash before the run unwinds never replays a
     message the Commander stopped, E-STOPped or replaced) is told, whoever wrote the reason; a throw there never stops
     the stop. */
  function markEnd(rec, reason) {
    if (!rec || typeof rec !== 'object' || rec.endReason) return false;
    rec.endReason = reason;
    if (typeof rec.onEnd === 'function') { try { rec.onEnd(reason); } catch (e) { if (failNote) failNote('halt.markEnd.onEnd', e); } }
    return true;
  }

  function killAll(runs, ...hubInflights) {
    let halted = 0;
    if (runs && typeof runs.values === 'function') {
      for (const ac of runs.values()) { try { if (ac && typeof ac.abort === 'function') ac.abort(); halted++; } catch (_) { halted++; } }
    }
    for (const hubInflight of hubInflights) {
      if (!hubInflight || typeof hubInflight.values !== 'function') continue;
      for (const rec of hubInflight.values()) {
        try {
          // 'halted', not 'superseded': both silence this run's now-stale partial, but they mean different things
          // downstream. A supersede means a NEWER message owns the conversation and is about to answer, so silence
          // is correct; an E-STOP means nothing else is coming, and on a phone (no floor, no browser, no other
          // signal) silence made a deliberate stop byte-identical to a crashed bot.
          if (rec) { markEnd(rec, 'halted'); if (rec.abort && typeof rec.abort.abort === 'function') rec.abort.abort(); }
        } catch (_) { /* an E-STOP must not throw */ }
        halted++;
      }
    }
    return halted;
  }

  /* markFaulted(...hubInflights) — the stop about to land is the station's OWN process-fault containment, never the Commander's
     E-STOP (wave 2 repair, conveyor-backend-08): call it on the same hub maps right BEFORE killAll. It stops nothing itself; it
     only writes endReason 'faulted' on each record, so whoever reads the ending (the hub's chat notice, the step test) names the
     fault instead of an E-STOP nobody pressed. Tolerant like killAll; returns the number of records marked (a run that already
     ended keeps its own reason). */
  function markFaulted(...hubInflights) {
    let marked = 0;
    for (const hubInflight of hubInflights) {
      if (!hubInflight || typeof hubInflight.values !== 'function') continue;
      for (const rec of hubInflight.values()) { if (markEnd(rec, 'faulted')) marked++; }
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

  return { killAll, markFaulted, killStopHandles, endOf, markEnd };
});
