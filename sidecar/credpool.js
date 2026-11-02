/* sidecar/credpool.js — credential pool ordering + cooldown for provider key rotation (P0.2).

   A single API key is a single point of failure: one 429 / quota-exhaustion / revoked-auth on it stalls the
   agent until a human intervenes. A production-class daily-driver rotates to the next key and keeps going. The
   loop ALREADY consumes errorClass's `shouldRotateCredential` (auth/billing/rate_limit) to advance its
   fallback chain (loop.js) — but today every chain entry reuses the SAME key, so there is nothing to rotate
   TO. This module is the missing half: it turns a primary key + a pool of alternates into an ORDERED, deduped
   candidate list, and remembers which keys recently failed so they sink to the back of the order (a cooldown)
   instead of being retried first next run.

   PURE + deterministic: the only state is an in-memory cooldown map, and all time comes from the injected
   `clock` — no Date.now, so it replays identically under test and passes lint-determinism. It NEVER logs or
   persists a key (keys live in memory only, like the credential store's keychain layer); it only orders opaque strings.

     makeCredPool({ clock, cooldownMs? }) -> {
       order(keys) -> string[],     // unique, non-empty; AVAILABLE keys keep their given order, COOLING keys
                                     //   sink to the end (soonest-available first); capped. Never empty if input isn't.
       penalize(key) -> void,       // mark a key as cooling until now + cooldownMs (call when it fails a rotate reason)
       coolingUntil(key) -> number  // ms timestamp the key is cooling until, or 0 if available
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).credpool = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min: long enough to skip a rate-limited key, short enough to recover
  const MAX_COOLDOWN_MS = 60 * 60 * 1000;      // 1 h ceiling: a bogus server "retry after 9999999s" can't strand a key all session
  const MAX_KEYS = 8;                           // a sane ceiling so a pasted blob can't build an unbounded chain

  function makeCredPool(opts) {
    opts = opts || {};
    const clock = opts.clock || { now() { return 0; } };
    const cooldownMs = (typeof opts.cooldownMs === 'number' && opts.cooldownMs >= 0) ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
    const maxCooldownMs = (typeof opts.maxCooldownMs === 'number' && opts.maxCooldownMs >= 0) ? opts.maxCooldownMs : MAX_COOLDOWN_MS;
    const cooling = new Map();   // key -> ms timestamp it is cooling until

    function coolingUntil(key) {
      const u = cooling.get(key);
      if (!u) return 0;
      if (u > clock.now()) return u;
      cooling.delete(key);   // expired — clear so the map can't grow unbounded
      return 0;
    }

    // dedupe + drop falsy, preserving first-seen order; then stable-partition available-before-cooling.
    function order(keys) {
      const seen = new Set();
      const uniq = [];
      for (const k of (Array.isArray(keys) ? keys : [])) {
        const s = (k == null ? '' : String(k));
        if (!s || seen.has(s)) continue;
        seen.add(s); uniq.push(s);
        if (uniq.length >= MAX_KEYS) break;
      }
      const available = [];
      const coolingList = [];
      // Read each key's cooldown ONCE. coolingUntil() prunes expired entries as a side effect, so calling it
      // from inside a sort comparator ran an unbounded number of mutating reads over the same map mid-sort —
      // harmless today only because the values were just observed non-zero. Snapshot, then sort on the
      // snapshot: the comparator becomes pure and the ordering can't depend on how many times it was called.
      for (const k of uniq) { const until = coolingUntil(k); (until ? coolingList : available).push({ k, until }); }
      coolingList.sort((a, b) => (a.until - b.until) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));   // soonest-available first
      return available.map(x => x.k).concat(coolingList.map(x => x.k));
    }

    // H6.1: an explicit ttlMs (e.g. derived from a Retry-After / reset_at) cools the key for EXACTLY that long —
    // honoring the server instead of a blind fixed window. ttlMs is clamped to [0, maxCooldownMs] so a bogus
    // "retry after 9999999s" can't strand a key for the whole session. No ttl => the default cooldown.
    function penalize(key, ttlMs) {
      const s = (key == null ? '' : String(key));
      if (!s) return;
      let ms = cooldownMs;
      if (typeof ttlMs === 'number' && isFinite(ttlMs) && ttlMs >= 0) ms = Math.min(ttlMs, maxCooldownMs);
      cooling.set(s, clock.now() + ms);
    }

    return { order, penalize, coolingUntil, _internals: { cooling, cooldownMs } };
  }

  return { makeCredPool, _internals: { DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS, MAX_KEYS } };
});
