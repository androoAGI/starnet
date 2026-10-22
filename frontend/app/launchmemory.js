/* AGENT OS — launchmemory.js : LAST-USED RECIPE INPUTS — kill the retype tax on every launch.

   The smallest possible practicality store (lane C of the recipe-system upgrade): every successful recipe
   launch (RUN NOW / RUN NOW INSTEAD / SCHEDULE IT) saves the param values the Commander actually filled, and
   the next time that recipe's launch form opens, the fields come back prefilled — Morning Brief remembers its
   topic. CONFIRM-BY-SIGHT is the safety model: prefilled values sit visibly in the form and nothing launches
   until the RUN button, so a stale value is seen (and the form shows a "using your last inputs" hint) before
   it can run. Values are the Commander's own local inputs — localStorage only, never pushed anywhere.

   Bounded on every axis: at most MAX_RECIPES recipes kept (LRU by save time), each value clipped to
   VALUE_MAX chars, whole-store read/write fail-open (corrupt storage → empty memory, never a crash).

   UMD-light: a `LaunchMemory` global in the browser, module.exports under node (node-testable with an
   injectable storage shim, the suggeststore.js pattern). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.LaunchMemory = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'starnet.launchvals.v1';
  const MAX_RECIPES = 40;     // LRU ceiling — a long-lived station keeps its recent recipes' inputs
  const VALUE_MAX = 2000;     // per-value clip: a pasted wall of text is remembered by its head, never unbounded
  const KEY_MAX = 24;         // param keys are short identifiers (mirrors scout PARAM_KEY_RE's ceiling)

  // storage seam: real localStorage in the browser; injectable for node tests; absent → memory-only no-op.
  let store = (typeof localStorage !== 'undefined') ? localStorage : null;

  function readAll() {
    try {
      if (!store) return { v: 1, byRecipe: {} };
      const raw = store.getItem(KEY);
      if (raw == null) return { v: 1, byRecipe: {} };
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || !o.byRecipe || typeof o.byRecipe !== 'object') return { v: 1, byRecipe: {} };
      return { v: 1, byRecipe: o.byRecipe };
    } catch (_) { return { v: 1, byRecipe: {} }; }   // corrupt storage → empty memory, never a crash
  }
  function writeAll(o) {
    try { if (store) store.setItem(KEY, JSON.stringify(o)); } catch (_) {}   // quota/denied → this save is lost, nothing else
  }

  // sanitize one values map: string values only, keys/values clipped, empties dropped (nothing to remember).
  function cleanValues(values) {
    const out = {};
    if (!values || typeof values !== 'object') return out;
    for (const k of Object.keys(values)) {
      const key = String(k).slice(0, KEY_MAX);
      const v = values[k];
      if (key && typeof v === 'string' && v.trim()) out[key] = v.slice(0, VALUE_MAX);
    }
    return out;
  }

  // remember the inputs a launch actually used. An all-blank form (a no-setup recipe) clears the entry instead —
  // there is nothing worth prefilling, and a stale leftover would lie about what last ran.
  function save(recipeId, values, at) {
    const id = recipeId ? String(recipeId).slice(0, 60) : '';
    if (!id) return;
    const all = readAll();
    const vals = cleanValues(values);
    if (!Object.keys(vals).length) { delete all.byRecipe[id]; writeAll(all); return; }
    all.byRecipe[id] = { values: vals, at: Number(at) || Date.now() };
    // LRU bound: oldest save times evicted past the ceiling.
    const ids = Object.keys(all.byRecipe);
    if (ids.length > MAX_RECIPES) {
      ids.sort((a, b) => (all.byRecipe[b].at || 0) - (all.byRecipe[a].at || 0));
      for (const k of ids.slice(MAX_RECIPES)) delete all.byRecipe[k];
    }
    writeAll(all);
  }

  // the last-used values for a recipe ({key: value}), or null when none were remembered.
  function get(recipeId) {
    const id = recipeId ? String(recipeId).slice(0, 60) : '';
    if (!id) return null;
    const rec = readAll().byRecipe[id];
    if (!rec || typeof rec !== 'object' || !rec.values || typeof rec.values !== 'object') return null;
    const vals = cleanValues(rec.values);
    return Object.keys(vals).length ? vals : null;
  }

  // the launches this memory remembers, newest-first ([{id, at}]) — the starter engine's "usual
  // recipe" signal. Reads the same store as get(); an empty/corrupt store honestly returns [].
  function recent(n) {
    const all = readAll();
    const out = [];
    for (const id of Object.keys(all.byRecipe)) {
      const rec = all.byRecipe[id];
      if (rec && typeof rec === 'object') out.push({ id: id, at: Number(rec.at) || 0 });
    }
    out.sort((a, b) => b.at - a.at);
    const cap = Number(n);
    return (isFinite(cap) && cap > 0) ? out.slice(0, cap) : out;
  }

  function clear(recipeId) {
    const id = recipeId ? String(recipeId).slice(0, 60) : '';
    if (!id) return;
    const all = readAll();
    if (all.byRecipe[id]) { delete all.byRecipe[id]; writeAll(all); }
  }

  // a brand-new hero starts with a clean memory (the same own-key discipline every session store follows).
  function reset() { try { if (store) store.removeItem(KEY); } catch (_) {} }

  return { save, get, recent, clear, reset, KEY, MAX_RECIPES, VALUE_MAX, _setStoreForTest: s => { store = s; } };
});
