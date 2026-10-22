/* AGENT OS — seedreuse.js : the PURE seed-reuse AGGREGATE engine (Game session, Phase G3b / Layer 6).

   G3a's SeedCredit is per-MOMENT ("this run reused the seed you saved"). This is the AGGREGATE half of the
   meta loop: it counts how often each Commander-saved seed genuinely ran, over a rolling 7-day window AND
   over the station's lifetime, so:
     • when a seed crosses N runs in the window (N=5), the station fires ONE gentle callout — "the seed you
       saved ran 5× this week" — fire-ONCE per window (it won't re-nag until the window rolls past that crest);
     • the lifetime counts live permanently on the TROPHY CASE's "living tools" shelf (livingTools()).

   HONEST provenance only (the whole reason SeedCredit exists): a run is credited to a seed ONLY when the
   provenance genuinely links — the caller passes the already-matched seed NAME (from SeedCredit.matchSeed /
   the digest's row.seed annotation). This engine never guesses which seed a run belongs to; it only tallies
   what the matcher already proved. An unmatched run contributes nothing.

   PURE + node-testable (a `SeedReuse` global; module.exports under node). No DOM/clock/rng — the caller
   injects nowMs and the matched seed name. Ring-capped per seed so a heavy user can't grow state unbounded. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SeedReuse = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // the rolling window: 7 days
  const THRESHOLD = 5;                          // N runs in the window → the callout fires (once per window crest)
  const STAMP_CAP = 40;                         // per-seed in-window timestamp ring (bounds state on a busy seed)
  const SEED_CAP = 60;                          // max distinct seeds tracked (oldest-touched evicted)

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const str = v => v == null ? '' : String(v);
  const key = name => str(name).replace(/\s+/g, ' ').trim().toLowerCase();

  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const seedsIn = (s.seeds && typeof s.seeds === 'object' && !Array.isArray(s.seeds)) ? s.seeds : {};
    const seeds = {};
    let n = 0;
    for (const k of Object.keys(seedsIn)) {
      if (n++ >= SEED_CAP) break;
      const e = seedsIn[k];
      if (!e || typeof e !== 'object') continue;
      const stamps = Array.isArray(e.stamps) ? e.stamps.map(num).filter(t => t > 0).slice(-STAMP_CAP) : [];
      seeds[k] = {
        name: str(e.name) || k,
        lifetime: Math.max(0, Math.floor(num(e.lifetime))),
        stamps,
        firedAt: Math.max(0, num(e.firedAt)),     // when the last window-crest callout fired (0 = never)
        touchedAt: Math.max(0, num(e.touchedAt))
      };
    }
    return { v: 1, seeds };
  }

  // drop in-window timestamps older than (nowMs - WINDOW) — the rolling window is enforced at read AND record.
  function prune(entry, nowMs) {
    const cut = num(nowMs) - WINDOW_MS;
    entry.stamps = entry.stamps.filter(t => t > cut);
    // a window that has fully rolled PAST the last fire re-arms the callout (fire-once is per crest, not forever)
    if (entry.firedAt && entry.firedAt <= cut) entry.firedAt = 0;
  }

  /* record ONE genuine seed-routine completion. name = the matched seed name (SeedCredit already proved the
     link); nowMs = injected wall-clock. Returns { state, crossed } — crossed = the seed's name IFF this run
     pushed its in-window count to exactly THRESHOLD and no callout has fired for this window yet (so the
     caller fires the gentle nudge exactly once). A blank name is a no-op (never tally an unmatched run). */
  function record(state, name, nowMs) {
    const s = hydrate(state);
    const k = key(name);
    if (!k) return { state: s, crossed: null };
    const now = num(nowMs);
    let e = s.seeds[k];
    if (!e) {
      // evict the oldest-touched seed if we're at the cap (bounded state)
      const ks = Object.keys(s.seeds);
      if (ks.length >= SEED_CAP) {
        let oldest = ks[0];
        for (const kk of ks) if ((s.seeds[kk].touchedAt || 0) < (s.seeds[oldest].touchedAt || 0)) oldest = kk;
        delete s.seeds[oldest];
      }
      e = s.seeds[k] = { name: str(name) || k, lifetime: 0, stamps: [], firedAt: 0, touchedAt: 0 };
    }
    e.name = str(name) || e.name;   // keep the freshest display casing
    e.lifetime += 1;
    e.touchedAt = now;
    prune(e, now);
    if (now > 0) e.stamps.push(now);
    if (e.stamps.length > STAMP_CAP) e.stamps = e.stamps.slice(-STAMP_CAP);

    let crossed = null;
    // fire the callout exactly when the count REACHES the threshold this record, and not already fired this window
    if (e.stamps.length === THRESHOLD && !e.firedAt) { e.firedAt = now || 1; crossed = e.name; }
    return { state: s, crossed };
  }

  // how many times this seed ran in the current rolling window (prunes as it reads — a stale stamp never counts).
  function windowCount(state, name, nowMs) {
    const s = hydrate(state);
    const e = s.seeds[key(name)];
    if (!e) return 0;
    const cut = num(nowMs) - WINDOW_MS;
    return e.stamps.filter(t => t > cut).length;
  }

  /* the LIVING TOOLS shelf for the trophy surface: every tracked seed with its lifetime + 7-day run counts.
     Sorted by lifetime desc (the most-used tool leads), then name. Seeds that never ran aren't here (lifetime>0
     is guaranteed — a seed only enters state on a real record). */
  function livingTools(state, nowMs) {
    const s = hydrate(state);
    const cut = num(nowMs) - WINDOW_MS;
    return Object.keys(s.seeds).map(k => {
      const e = s.seeds[k];
      return { name: e.name, runs: e.lifetime, sevenDay: e.stamps.filter(t => t > cut).length };
    }).filter(t => t.runs > 0)
      .sort((a, b) => (b.runs - a.runs) || String(a.name).localeCompare(String(b.name)));
  }

  return { hydrate, record, windowCount, livingTools, WINDOW_MS, THRESHOLD, SEED_CAP, STAMP_CAP };
});
