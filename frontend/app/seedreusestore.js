/* AGENT OS — seedreusestore.js : the thin live wiring around the pure seed-reuse AGGREGATE engine (seedreuse.js).

   Owns what the pure engine can't: the durable localStorage key (its OWN 'starnet.seedreuse.*' key, riding the
   backup prefix like pridestore/returnstore — no save.js change), the fire-once-per-window callout through the
   existing GENTLE-NUDGE family (Chat.nudge, the same quiet register curiosity/suggestion/seed asks use), and the
   read surface the TROPHY CASE's living-tools shelf renders from.

   The provenance is ALREADY proved upstream: returnstore's digest annotates each while-away run row with
   `.seed` = the Commander-saved seed it genuinely reused (SeedCredit.matchSeed). We only tally what the matcher
   proved — a run with no `.seed` contributes nothing (honest counts, never guessed). A digested run is listed
   ONCE (returns.js never re-lists), so each reuse is counted exactly once.

   Discipline (mirrors pridestore/returnstore): NEVER emits on U.bus — the frozen shared/events.js contract is
   owned elsewhere; the callout is a direct Chat.nudge call, so lint-emits stays green. node-exportable for its test. */
'use strict';
const SeedReuseStore = (() => {
  const KEY = 'starnet.seedreuse.v1';
  let state = null;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof SeedReuse !== 'undefined' && !!state;

  function init() {
    state = (typeof SeedReuse !== 'undefined') ? SeedReuse.hydrate(load()) : null;
    if (state) save();   // persist the hydrated shape once so a first-ever open has a durable row
  }

  // fire the gentle "your seed ran 5× this week" callout — one aside in the shared beat register, never a
  // separate panel, never an XP mint. A single acknowledge choice keeps it in the nudge family + lets the
  // one-at-a-time clearNudge lifecycle retire it, exactly like the suggestion/seed nudges.
  function callout(name, count) {
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    const line = '✦ the seed you saved — “' + String(name) + '” — ran ' + count + '× this week. it’s pulling real weight now.';
    if (typeof SFX !== 'undefined' && SFX.seed) { try { SFX.seed(); } catch (_) {} }   // reuse the seed chime (a living tool, not a new sound)
    Chat.nudge(line, [{ label: 'nice', value: 'ok', skip: true }], () => {});
  }

  // record ONE provenance-matched seed reuse (the seed's proven name). Fires the window-crest callout at most
  // once per window. Direct entry point (kept for tests / a future attended-run hook).
  function recordSeed(name) {
    if (!ready() || !name) return;
    try {
      const r = SeedReuse.record(state, name, Date.now());
      state = r.state; save();
      if (r.crossed) callout(r.crossed, SeedReuse.THRESHOLD);
    } catch (_) {}
  }

  // feed the digest's already-annotated rows: every row carrying a genuine `.seed` provenance is one real
  // reuse. Called by returnstore right after SeedCredit.annotate — the canonical while-away routine-run source.
  function recordAnnotatedRows(rows) {
    if (!ready() || !Array.isArray(rows)) return;
    for (const r of rows) { if (r && r.seed) recordSeed(r.seed); }
  }

  // the living-tools shelf the TROPHY CASE renders: [{ name, runs (lifetime), sevenDay }]. Honest counts only.
  function livingTools() { return ready() ? SeedReuse.livingTools(state, Date.now()) : []; }
  function windowCount(name) { return ready() ? SeedReuse.windowCount(state, name, Date.now()) : 0; }

  // S2/new-hero: a fresh Commander inherits no prior tool-usage history (own key, like the other stores).
  function reset() { state = (typeof SeedReuse !== 'undefined') ? SeedReuse.hydrate(null) : null; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, recordSeed, recordAnnotatedRows, livingTools, windowCount, reset };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { SeedReuseStore };
