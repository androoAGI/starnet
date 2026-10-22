/* AGENT OS — legacymigrate.js : one-time localStorage key migration for the Skynet→Agent OS rename.

   The project was renamed Skynet → Agent OS. Every browser-side key the app owns moved from the
   `skynet.*` prefix to `starnet.*`. This script runs FIRST (before any store reads localStorage —
   it is the very first <script> in index.html) and copies each legacy `skynet.*` key forward to its
   `starnet.*` name when the new key is absent. The OLD keys are LEFT IN PLACE as a rollback, so a
   downgrade still finds its data and a botched migration loses nothing. Idempotent (re-running is a
   no-op once the new keys exist) and origin-scoped (localStorage is per port, so this only ever
   touches the one origin the user loads — there is no cross-tab/worktree split-brain).

   The planning core is a PURE function so it is unit-testable headless; run() just binds it to a
   real Storage. No dependencies — safe to load before everything else. */
'use strict';

const LegacyMigrate = (() => {
  const LEGACY = 'skynet.';
  const CURRENT = 'starnet.';

  // pure: given a snapshot of [key, value] entries, return the [{ key, value }] writes needed to bring
  // every legacy `skynet.*` key forward — skipping any whose `starnet.*` target already exists (never clobber).
  function plan(entries) {
    const have = new Set(entries.map(e => e[0]));
    const writes = [];
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || k.indexOf(LEGACY) !== 0) continue;
      const nk = CURRENT + k.slice(LEGACY.length);
      if (have.has(nk)) continue;
      writes.push({ key: nk, value: v });
    }
    return writes;
  }

  function run(storage) {
    try {
      const entries = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); entries.push([k, storage.getItem(k)]); }
      const writes = plan(entries);
      for (const w of writes) storage.setItem(w.key, w.value);
      return writes.length;
    } catch (_) { return 0; }
  }

  // run immediately in the browser, before any store reads its key.
  if (typeof window !== 'undefined' && window.localStorage) { try { run(window.localStorage); } catch (_) {} }

  return { plan, run, LEGACY, CURRENT };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LegacyMigrate;
