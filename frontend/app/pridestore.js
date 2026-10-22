/* AGENT OS — pridestore.js : the thin live wiring around the pure lifetime-record engine (pride.js).

   Owns what the pure engine can't: the durable localStorage key (its OWN 'starnet.pride.*' key, riding the
   backup prefix like returnstore/mintstore — no save.js change), the U.bus subscriptions that feed real
   outcomes into the fold, and the injected wall-clock. The STATION RECORD surface (stationui.js) reads
   snapshot() at render time.

   Discipline (mirrors returnstore.js): NEVER emits on U.bus — it only .on()s (the frozen shared/events.js
   contract is owned elsewhere; lint-emits stays green). Fold is debounce-persisted so a busy run's event
   storm doesn't hammer localStorage. node-exportable for its test. */
'use strict';
const PrideStore = (() => {
  const KEY = 'starnet.pride.v1';
  const FEED = ['agent.run.start', 'agent.run.end', 'workitem.delivered', 'cron.fire'];
  let state = null;
  let wired = false;
  let saveTimer = 0;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  // coalesce writes: a run's event burst folds many times but persists at most every ~800ms (+ a final flush).
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = 0; save(); }, 800);
  }
  const ready = () => typeof Pride !== 'undefined' && !!state;

  function onEvent(name, p) {
    if (!ready()) return;
    try { state = Pride.fold(state, name, p, Date.now()); saveSoon(); } catch (_) {}
  }

  function init() {
    state = (typeof Pride !== 'undefined') ? Pride.hydrate(load()) : null;
    if (!state) return;
    save();   // persist the hydrated (founding-safe) shape once so a first-ever open has a durable row
    if (!wired && typeof U !== 'undefined' && U.bus && U.bus.on) {
      wired = true;
      for (const n of FEED) U.bus.on(n, p => onEvent(n, p));
      try { window.addEventListener('beforeunload', () => { if (state) save(); }); } catch (_) {}
    }
  }

  // the STATION RECORD readout (stationui.js reads this at render). Honest "—" flags live in the snapshot.
  function snapshot() { return ready() ? Pride.snapshot(state) : null; }

  // S2/new-hero: a fresh Commander founds a brand-new station — no inherited lifetime record.
  function reset() { state = (typeof Pride !== 'undefined') ? Pride.hydrate(null) : null; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, snapshot, reset };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PrideStore };
