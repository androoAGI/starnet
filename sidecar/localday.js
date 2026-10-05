/* sidecar/localday.js — the LOCAL calendar-day bucket every night-shift day key is computed from.

   THE PROBLEM THIS CLOSES (2026-10-05 night-shift audit, item 6): nightshift.js reset the daily leash at UTC
   midnight (floor(now/86400000)). For a Commander in UTC-5 that is 7 PM local — the leash refilled in the middle
   of the evening and "today's" beats straddled two of their real days. The leash, the night focus, and the
   "what you produced tonight" scope must all agree on ONE day, and it must be the user's calendar day.

   DETERMINISM SPLIT: this module never reads the ambient clock or the machine timezone. The offset is INJECTED —
   configure(fn) installs `fn(ms) -> offset ms to ADD to UTC to reach local wall time` (the composition root
   passes the machine's real offset, DST-aware because it is asked per instant). Unconfigured = offset 0 = the
   historical UTC behavior, so every pure test that never configures a timezone keeps its exact day buckets.
   Every function also takes an explicit `tz` override (a number of ms, or a fn) so a test can pin a zone without
   touching the module-wide setting. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).localday = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const MAX_OFFSET_MS = 14 * 3600000;   // real zones span UTC-12..UTC+14; anything wider is a bad injection → 0

  let offsetAt = null;                  // fn(ms) -> ms; null = UTC

  // configure(fnOrMs) — install the host's offset source. A finite number is a fixed offset in ms; a function is
  // asked per instant (DST-correct); anything else resets to UTC. Returns the previous source (tests restore it).
  function configure(src) {
    const prev = offsetAt;
    if (typeof src === 'function') offsetAt = src;
    else if (typeof src === 'number' && isFinite(src)) offsetAt = (() => src);
    else offsetAt = null;
    return prev;
  }

  // the offset (ms) for instant t. `tz` (number | fn) overrides the configured source. Never throws; a bad or
  // out-of-range value degrades to 0 (UTC) rather than producing a day bucket that could skip or repeat a day.
  function offsetFor(t, tz) {
    let off = 0;
    try {
      const src = (tz !== undefined && tz !== null) ? tz : offsetAt;
      if (typeof src === 'function') off = Number(src(t));
      else if (typeof src === 'number') off = src;
    } catch (_) { off = 0; }
    if (!isFinite(off) || Math.abs(off) > MAX_OFFSET_MS) return 0;
    return off;
  }

  // the local calendar-day number of instant t (days since the local epoch midnight). Same integer space as the old
  // UTC bucket when the offset is 0.
  function dayOf(t, tz) {
    const n = Number(t) || 0;
    return Math.floor((n + offsetFor(n, tz)) / DAY_MS);
  }

  // the UTC instant the local day `day` begins (its local midnight). Useful for "resets at" telemetry.
  // Offsets are taken at the candidate instant; across a DST edge the true midnight is within an hour of it.
  function dayStartMs(day, tz) {
    const guess = Math.floor(Number(day) || 0) * DAY_MS;
    return guess - offsetFor(guess, tz);
  }

  function utcDayOf(t) { return Math.floor((Number(t) || 0) / DAY_MS); }

  return { configure, offsetFor, dayOf, dayStartMs, utcDayOf, DAY_MS, MAX_OFFSET_MS };
});
