/* AGENT OS — mintstore.js : the browser wiring for the AUTO-MINT engine (mint.js).

   The read/observe surface the app talks to. It folds each TASK DIRECTIVE the Commander sends into mint.js's
   recurrence map and surfaces the resulting proposals to the Recruitment Bay's RECIPES tab. Mirrors the
   xpstore.js / profilestore.js pattern: a thin browser global that supplies Date.now at the edge (mint.js stays
   clock-injected + deterministic) and NEVER emits on U.bus — the shared event contract is owned by the
   cortex-memory workstream (additive-only). Honors the same learning-enabled flag the profile glass box controls.

   Persists to its OWN localStorage key (starnet.mint.v1) — like the custom specialty/recipe stores — so it rides
   backup.js's `starnet.` prefix export for free and resumes itself on reload without touching the save envelope. */
'use strict';
const MintStore = (() => {
  const KEY = 'starnet.mint.v1';
  let state = null;

  function now() { return Date.now(); }   // the only ambient clock — injected into the pure engine at the edge
  function ready() { return !!state && typeof Mint !== 'undefined'; }

  function load() {
    try { if (typeof localStorage !== 'undefined') { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } } catch (_) {}
    return null;
  }
  function persist() {
    try { if (typeof localStorage !== 'undefined' && state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }

  // start from a passed slice, else the self-persisted localStorage, else fresh. Defensive hydrate either way.
  function init(opts) {
    opts = opts || {};
    state = (typeof Mint !== 'undefined') ? Mint.hydrate(opts.state || load()) : null;
    persist();
  }

  // the direct hook from chat.js: fold one task directive (already classified as a task by the caller). Gated on
  // the learning flag; re-checks isTaskDirective defensively so a stray caller can't poison the map with chatter.
  function observe(text) {
    if (!ready() || !state.enabled) return;
    if (typeof Classify !== 'undefined' && Classify.isTaskDirective && !Classify.isTaskDirective(text)) return;
    Mint.observe(state, text, now());
    persist();
  }

  const SEED_MAX_PROPOSED = 2;   // a seed nudge stops re-offering a shape after this many ignored offers (stop-forever)
  function candidates() { return ready() ? Mint.candidates(state, { now: now() }) : []; }
  // the GENTLE seed nudge reads this (not candidates()): it hides a shape already offered-and-ignored enough times,
  // so an ignored seed stops looping across sessions. The RECIPES tab keeps using candidates() (no ceiling).
  function nudgeCandidates() { return ready() ? Mint.candidates(state, { now: now(), maxProposed: SEED_MAX_PROPOSED }) : []; }
  // is this directive's task SHAPE recurring (seen >= RECUR_MIN times)? The salience signal the memory beat reads to
  // honour "basic one-off stays silent, recurring work earns the ask". Call AFTER observe() so it counts this run.
  function recurringNow(text) { return ready() ? Mint.seenCount(state, text) >= Mint.RECUR_MIN : false; }
  function markMinted(key) { if (ready()) { Mint.markMinted(state, key); persist(); } }
  function markDismissed(key) { if (ready()) { Mint.markDismissed(state, key); persist(); } }
  function markProposed(key) { if (ready()) { Mint.markProposed(state, key); persist(); } }
  function enabled() { return ready() ? !!state.enabled : true; }
  function setEnabled(on) { if (ready()) { Mint.setEnabled(state, on); persist(); } }
  function forget() { if (ready()) { state = Mint.forget(state); persist(); } }
  // S1: a NEW AGENT starts with no recurring-task memory. Drop the self-persisted key so the next init()
  // hydrates clean (Save.clear() only wipes starnet.save — this store persists to its own key).
  function reset() { state = null; try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY); } catch (_) {} }
  function serialize() { return ready() ? JSON.parse(JSON.stringify(state)) : null; }

  return { init, observe, candidates, nudgeCandidates, recurringNow, markMinted, markDismissed, markProposed, enabled, setEnabled, forget, reset, serialize };
})();
