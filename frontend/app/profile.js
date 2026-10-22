/* AGENT OS — profile.js : the PURE user-affinity engine (the "knows how you work" substrate).

   The recommender's fuel: a tiny per-interest histogram (the same {code|research|general} tags
   classify.js already derives from every message) with EWMA recency decay + a sample count, so it
   sharpens with use and honestly reports "calibrating" until it has earned a read. It stores only
   DERIVED COUNTS — never raw prompt text — so it is safe to fold silently (same justification as the
   agent's own notebook), and it is local-first: this object lives in the user's save and never leaves
   the machine.

   PURE + testable, mirroring xp.js: a `Profile` global in the browser, module.exports under node. The
   clock is ALWAYS injected (`now`) — no Date.now / Math.random here — so decay is deterministic and the
   node tests can fast-forward time. The browser wiring (profilestore.js) supplies Date.now() at the edge. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Profile = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (one place to retune the whole feel) ----
  const TAGS = ['code', 'research', 'general'];   // the interest vocabulary (mirrors classify.js getTag)
  const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;  // a tag's weight halves every ~2 weeks of silence (recency)
  const CALIBRATING_N = 5;                         // observations before the read is "known" (else: calibrating)
  const FAMILIAR_N = 24;                           // observations at which "STATION FAMILIARITY" reads 100% (honest meter ceiling)
  const SEED_WEIGHT = 2;                           // a cold-start seed's pull, ~2 observations' worth, fades as real data accrues

  function fresh() { return { v: 1, tags: {}, seed: null, enabled: true, total: 0 }; }
  function normTag(tag) { return TAGS.indexOf(tag) >= 0 ? tag : 'general'; }

  // a tag's stored weight, exponentially decayed by the silence since it was last touched.
  function decayedW(tagObj, now) {
    if (!tagObj || typeof tagObj.w !== 'number') return 0;
    const dt = Math.max(0, now - (tagObj.t || 0));
    return tagObj.w * Math.pow(0.5, dt / HALF_LIFE_MS);
  }

  // the seed prior fades linearly to nothing as real observations reach CALIBRATING_N.
  function seedScale(profile) {
    const used = Math.min(profile.total || 0, CALIBRATING_N);
    return Math.max(0, 1 - used / CALIBRATING_N);
  }

  // the normalized interest vector {code,research,general} ∈ [0,1], decayed to `now`, with the
  // cold-start seed blended in while signal is thin. The single source the scorer + summary read.
  function vector(profile, now) {
    const dw = {}; let total = 0;
    for (const k of TAGS) { dw[k] = profile.tags[k] ? decayedW(profile.tags[k], now) : 0; total += dw[k]; }
    if (profile.seed && profile.seed.tag) {
      const add = SEED_WEIGHT * seedScale(profile);
      if (add > 0) { dw[profile.seed.tag] = (dw[profile.seed.tag] || 0) + add; total += add; }
    }
    const out = {};
    for (const k of TAGS) out[k] = total > 0 ? dw[k] / total : 0;
    return out;
  }

  // fold one observation. sig = { tag, weight? }. No-op when learning is paused. Returns the profile.
  function observe(profile, sig, now) {
    if (!profile || profile.enabled === false) return profile;
    const tag = normTag(sig && sig.tag);
    const weight = (sig && Number.isFinite(sig.weight) && sig.weight > 0) ? sig.weight : 1;   // reject Infinity/NaN — a non-finite weight would poison the whole vector
    const cur = profile.tags[tag];
    profile.tags[tag] = { w: decayedW(cur, now) + weight, n: (cur ? cur.n : 0) + 1, t: now };
    profile.total = (profile.total || 0) + 1;
    return profile;
  }

  // a cold-start prior (the onboarding chip / chosen specialty). FIRST seed wins, and only on a profile
  // that has no real observations yet — so re-entering the game never clobbers a learned profile.
  function seed(profile, tag) {
    if (!profile || profile.enabled === false || profile.seed || (profile.total || 0) > 0) return profile;   // a paused learner is not seeded either
    profile.seed = { tag: normTag(tag) };
    return profile;
  }

  function affinity(profile, tag, now) { return vector(profile, now)[normTag(tag)]; }

  // rank a catalog item by how well its tag weights match the user's interest vector.
  // itemTags = { code:1 } or { code:0.6, research:0.4 }.
  function score(profile, itemTags, now) {
    const v = vector(profile, now);
    let s = 0;
    for (const k of TAGS) s += (itemTags && typeof itemTags[k] === 'number' ? itemTags[k] : 0) * v[k];
    return s;
  }

  // the single tag that contributed MOST to an item's score — the honest, deterministic source of the
  // "because you…" line on a recommendation. Returns null when there is no positive contribution (a cold
  // profile, or an item that doesn't intersect the user's interests) so the UI can stay silent rather than
  // fabricate a reason.
  function explain(profile, itemTags, now) {
    const v = vector(profile, now);
    let bestTag = null, best = 0;
    for (const k of TAGS) {
      const c = (itemTags && typeof itemTags[k] === 'number' ? itemTags[k] : 0) * v[k];
      if (c > best) { best = c; bestTag = k; }
    }
    return bestTag;
  }

  // the human-facing read: the vector, the dominant interest, how many samples, and whether it's earned.
  function summary(profile, now) {
    const v = vector(profile, now);
    const samples = profile.total || 0;
    let dominant = null, best = -1;
    for (const k of TAGS) if (v[k] > best) { best = v[k]; dominant = k; }
    const hasSignal = samples > 0 || !!(profile.seed && profile.seed.tag);
    return {
      affinity: v,
      dominant: hasSignal && best > 0 ? dominant : null,
      samples,
      calibrating: samples < CALIBRATING_N,
      familiarity: Math.min(1, samples / FAMILIAR_N)   // 0..1 — the honest "how well I know you" meter (CALIBRATING below the floor)
    };
  }

  function setEnabled(profile, on) { if (profile) profile.enabled = !!on; return profile; }

  // wipe the learned model (and the seed) but keep the user's learning-on/off choice.
  function forget(profile) { const p = fresh(); if (profile) p.enabled = profile.enabled !== false; return p; }

  // defensively rebuild a valid profile from a (possibly malformed / old) persisted blob.
  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return fresh();
    const p = fresh();
    p.enabled = raw.enabled !== false;
    p.total = (typeof raw.total === 'number' && raw.total >= 0) ? raw.total : 0;
    if (raw.seed && typeof raw.seed.tag === 'string') p.seed = { tag: normTag(raw.seed.tag) };
    if (raw.tags && typeof raw.tags === 'object') {
      for (const k of TAGS) {
        const tg = raw.tags[k];
        if (tg && Number.isFinite(tg.w) && tg.w >= 0) p.tags[k] = { w: tg.w, n: Math.max(0, tg.n | 0), t: (Number.isFinite(tg.t) ? tg.t : 0) };
      }
    }
    return p;
  }

  return { fresh, observe, seed, affinity, score, explain, vector, summary, setEnabled, forget, hydrate, TAGS, CALIBRATING_N, FAMILIAR_N, HALF_LIFE_MS };
});
