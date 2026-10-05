/* sidecar/nightshift.js — the PURE planner for the server-owned NIGHT-SHIFT driver (autonomy layer, NS-1).

   THE PROBLEM THIS CLOSES: the whole idle-autonomy loop used to live in the frontend webview
   (autopilotstore.js: a setInterval spending ONE beat per idle episode via an `armed` flag re-armed only on
   pointerdown/keydown, leash budget in localStorage). It died silently on sleep / tab-throttle / restart — so
   the Commander could leave the dial at max overnight and get ONE autonomous act, then hours of silence. This
   engine moves the SCHEDULING DECISION server-side: a restart-safe ticker that, while the Commander is away,
   attempts one autonomous beat every ~45 min, leash-capped (leash now ENFORCED server-side), day-rolling, and
   E-STOP-aware. The ACT pipeline itself is still the pure autopilot.js reason-only flow — this file owns only
   the ENGINE decision: should a beat fire on THIS tick, or not, and if not, which gate is binding.

   DETERMINISM SPLIT (mirrors cron.js/cron-store.js): every function here is a transform over (state, args) with
   `now` INJECTED as a parameter — NO Date.now / Math.random / new Date() / setInterval / fs / crypto — so it
   passes lint-determinism.js and is headless-testable with a fake clock (exactly like cron-store.js / loop.js /
   permissions.js). The ambient half — the real setInterval, Date.now, the workspaces JSON load/persist, the
   runOnce fire — lives ONLY in sidecar/index.js + sidecar/nightshift-driver.js.

   THE PERSISTED DRIVER STATE (one small workspaces JSON, so a restart resumes mid-night, not resets):
     { v, day, beatsUsedToday, lastBeatAt }
   day = the LOCAL calendar-day the counter belongs to (localday.js — the host injects the machine's timezone; an
   unconfigured process is UTC); a new day rolls beatsUsedToday to 0. v1 states were stamped with the UTC bucket and
   are re-keyed on load (see normalize) so the switch neither refills nor double-spends a leash.

   THE GATES (each individually binding; decide() names WHICH one blocks a beat, for truthful telemetry):
     · posture     — initiative must be ≥ 'leash' (the dial permits acting unattended). Below that → binding:'posture'.
     · away        — the Commander must be away (now - lastUserActivityAt ≥ awayThresholdMs). Present → binding:'present'.
     · leash       — beatsUsedToday < leashPerDay (server-enforced, persisted, day-rolled). Spent → binding:'leash'.
     · cooldown    — now - lastBeatAt ≥ beatIntervalMs (steady cadence, not a burst). Too soon → binding:'cooldown'.
     · halt        — the E-STOP must not be engaged. Halted → binding:'halt'.
     · concurrency — the same-agent run mutex must be free (checked in the driver, not here; passed as a flag).
   ONLY when every gate clears does decide() return { fire:true, binding:null }. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./localday.js') : (root.SK && root.SK.localday));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).nightshift = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LocalDay) {
  'use strict';

  const STATE_VERSION = 2;   // v2 (2026-10-05): `day` is the LOCAL calendar day (v1 = UTC bucket)
  const DEFAULT_AWAY_MS = 30 * 60 * 1000;    // "the Commander stepped out" = no user-surface activity for 30 min
  const DEFAULT_BEAT_MS = 45 * 60 * 1000;    // steady cadence: at most one autonomous beat every ~45 min
  const DAY_MS = 86400000;

  // the LOCAL calendar day (the leash resets at the Commander's midnight, not UTC's). Deterministic: the offset is
  // injected into localday.js by the host; `tz` optionally pins one for a single call (tests).
  const dayOf = (t, tz) => LocalDay.dayOf(t, tz);

  // fresh() — the safe floor: no beats spent, no beat ever fired. day is set the first time state is rolled.
  function fresh(now) { return { v: STATE_VERSION, day: dayOf(now || 0), beatsUsedToday: 0, lastBeatAt: 0, haltedAt: 0 }; }

  // tolerant hydrate: clamp every field to a sane value. A corrupt/old/partial save degrades to the floor per
  // field — never throws, never yields a state the gates could misread (e.g. a NaN counter that reads as < cap).
  function normalize(raw, now) {
    const s = fresh(now);
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.day)) s.day = Math.floor(raw.day);
      if (Number.isFinite(raw.beatsUsedToday) && raw.beatsUsedToday >= 0) s.beatsUsedToday = Math.floor(raw.beatsUsedToday);
      if (Number.isFinite(raw.lastBeatAt) && raw.lastBeatAt >= 0) s.lastBeatAt = Math.floor(raw.lastBeatAt);
      if (Number.isFinite(raw.haltedAt) && raw.haltedAt >= 0) s.haltedAt = Math.floor(raw.haltedAt);   // NS E-STOP durable halt
      // v1 → v2 RE-KEY: a v1 `day` is a UTC bucket. When the newest beat belongs to that bucket, its LOCAL day is
      // the honest key for the counter (those beats happened on that local day) — so the upgrade neither refills
      // an already-spent leash nor charges today for yesterday. Otherwise the counter holds no beats from a known
      // instant; keep the value and let rollDay compare it normally. Offset 0 makes this an identity.
      if (raw.v === 1 && s.lastBeatAt > 0 && LocalDay.utcDayOf(s.lastBeatAt) === s.day) s.day = dayOf(s.lastBeatAt);
    }
    return s;
  }

  // DAY ROLLOVER — return a NEW state with the leash counter reset iff `now` falls in a later day-bucket than the
  // state's stamped day. Pure (now injected); the input is never mutated. A restart mid-night keeps the same day
  // (and thus the same beatsUsedToday), which is exactly the resume-not-reset property NS-1 requires.
  function rollDay(state, now) {
    const s = normalize(state, now);
    const d = dayOf(now);
    if (s.day === d) return s;
    return { v: STATE_VERSION, day: d, beatsUsedToday: 0, lastBeatAt: s.lastBeatAt, haltedAt: s.haltedAt };   // keep lastBeatAt (cadence spans midnight) + halt (E-STOP is not a daily thing)
  }

  // remaining leash beats today, AFTER a day-roll. cap comes from the posture's leashPerDay (server copy). A
  // non-finite/absent cap fails safe to 0 (no posture → no beats), NOT Infinity — the driver must never run
  // unbounded because a posture field was missing.
  function beatsLeft(state, now, leashPerDay) {
    const s = rollDay(state, now);
    const cap = Number.isFinite(leashPerDay) ? Math.max(0, Math.floor(leashPerDay)) : 0;
    return Math.max(0, cap - (s.beatsUsedToday || 0));
  }

  // is the Commander away? (now - lastUserActivityAt ≥ the away span). An unknown/never-stamped lastActivity (0
  // or non-finite) reads as AWAY only if the app has been up at least awayThresholdMs — but the driver passes a
  // real lastUserActivityAt seeded at boot, so a fresh boot is treated as PRESENT until the threshold elapses.
  // Kept as a pure predicate here; the driver owns the boot seed.
  function isAway(now, lastUserActivityAt, awayThresholdMs) {
    if (!Number.isFinite(now) || !Number.isFinite(lastUserActivityAt)) return false;
    const span = Number.isFinite(awayThresholdMs) ? awayThresholdMs : DEFAULT_AWAY_MS;
    return (now - lastUserActivityAt) >= span;
  }

  /* decide — THE per-tick decision. Pure: a deterministic function of (state, the live inputs, the knobs). Returns
       { fire:boolean, binding:string|null, beatsLeft, away, nextEligibleAt }
     binding names the FIRST gate that blocks a beat (posture → present → halt → leash → cooldown), or null when a
     beat fires. Order is chosen for legibility: the most "the Commander decided this" reasons first (dial, presence,
     E-STOP), then the earned/rate limits (leash, cooldown). nextEligibleAt is the wall-clock the cooldown next
     clears (lastBeatAt + beatIntervalMs), so the status route can show "next beat eligible at …" honestly.
       inp: {
         now, lastUserActivityAt,
         actsUnattended,       // posture initiative ≥ 'leash' (Autonomy.summary().actsUnattended)
         leashPerDay,          // the posture's daily cap (server copy)
         halted,               // the E-STOP is engaged
         concurrencyFree,      // the same-agent run mutex is free (driver-checked; default true)
         awayThresholdMs, beatIntervalMs
       } */
  function decide(state, inp) {
    inp = inp || {};
    const now = inp.now;
    const s = rollDay(state, now);
    const away = isAway(now, inp.lastUserActivityAt, inp.awayThresholdMs);
    const left = beatsLeft(s, now, inp.leashPerDay);
    const beatMs = Number.isFinite(inp.beatIntervalMs) ? inp.beatIntervalMs : DEFAULT_BEAT_MS;
    const nextEligibleAt = (s.lastBeatAt || 0) + beatMs;
    const cooldownClear = !Number.isFinite(now) || (now - (s.lastBeatAt || 0)) >= beatMs;
    const concurrencyFree = inp.concurrencyFree !== false;   // default true (absent = free)

    const base = { fire: false, beatsLeft: left, away: away, nextEligibleAt: nextEligibleAt };
    if (!inp.actsUnattended) return Object.assign(base, { binding: 'posture' });   // dial hasn't reached 'leash'
    if (!away) return Object.assign(base, { binding: 'present' });                 // the Commander is here
    if (inp.halted) return Object.assign(base, { binding: 'halt' });               // E-STOP engaged
    if (left <= 0) return Object.assign(base, { binding: 'leash' });               // today's leash is spent
    if (!cooldownClear) return Object.assign(base, { binding: 'cooldown' });       // too soon since the last beat
    if (!concurrencyFree) return Object.assign(base, { binding: 'concurrency' });  // the agent's desk is busy
    return Object.assign(base, { fire: true, binding: null });
  }

  // recordBeat — after a beat FIRES, return a NEW state with the leash counter incremented + lastBeatAt stamped
  // (day-rolled first, so a beat that fires across midnight counts against the NEW day). Pure; input not mutated.
  function recordBeat(state, now) {
    const s = rollDay(state, now);
    return { v: STATE_VERSION, day: s.day, beatsUsedToday: (s.beatsUsedToday || 0) + 1, lastBeatAt: Number.isFinite(now) ? Math.floor(now) : (s.lastBeatAt || 0), haltedAt: s.haltedAt };
  }

  // ---- NS E-STOP durable halt. engageHalt stamps the halt instant on the state; clearHalt lifts it. Both are
  // PURE (now injected), preserve the leash counters, and round-trip through toEnvelope — so an E-STOP SURVIVES a
  // restart (a reboot must never silently re-enable overnight spend). isHalted(state) is the gate predicate the
  // driver injects; decide() then returns binding:'halt' every tick until the Commander re-writes the dial.
  function engageHalt(state, now) { const s = normalize(state, now); s.haltedAt = Number.isFinite(now) ? Math.floor(now) : (s.haltedAt || 0); return s; }
  function clearHalt(state, now) { const s = normalize(state, now); s.haltedAt = 0; return s; }
  function isHalted(state) { const s = normalize(state, 0); return (s.haltedAt || 0) > 0; }

  /* loadEnvelope / toEnvelope — the persistence normalizers (mirrors cron-store.loadEnvelope). Tolerates a JSON
     string, a parsed object, null, or garbage; fail-closed to the floor. `now` anchors a fresh day bucket when
     the file is absent/corrupt (so a first-ever boot doesn't read as "day 0, ancient" and instant-roll). */
  function loadEnvelope(raw, now) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object') return normalize(null, now);
    return normalize(obj, now);
  }
  function toEnvelope(state, now) { const s = normalize(state, now); return { v: STATE_VERSION, day: s.day, beatsUsedToday: s.beatsUsedToday, lastBeatAt: s.lastBeatAt, haltedAt: s.haltedAt }; }

  return {
    fresh, normalize, rollDay, beatsLeft, isAway, decide, recordBeat, engageHalt, clearHalt, isHalted, loadEnvelope, toEnvelope, dayOf,
    STATE_VERSION, DEFAULT_AWAY_MS, DEFAULT_BEAT_MS, DAY_MS
  };
});
