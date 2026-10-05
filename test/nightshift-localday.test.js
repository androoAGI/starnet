/* node test/nightshift-localday.test.js — the night-shift DAY KEY is the Commander's LOCAL calendar day.

   2026-10-05 audit item 6: nightshift.js reset the daily leash at UTC midnight (7 PM for a UTC-5 Commander), so the
   leash refilled mid-evening. Proves, with the offset INJECTED (never the machine zone):
     · localday.dayOf is the UTC bucket when unconfigured (every legacy pure test keeps its exact days)
     · with UTC-5 the leash does NOT roll at UTC midnight, and DOES roll at local midnight
     · a per-instant offset fn (DST) is honored; a garbage/out-of-range offset degrades to UTC, never throws
     · nightfocus uses the SAME day key as the leash (a new local day re-resolves the focus, UTC midnight doesn't)
     · a v1 (UTC-keyed) persisted state is re-keyed on load: a spent leash is neither refilled nor double-charged */
'use strict';
const A = require('./_assert.js');
const LocalDay = require('../sidecar/localday.js');
const ns = require('../sidecar/nightshift.js');
const nf = require('../sidecar/nightfocus.js');

const DAY = 86400000, HOUR = 3600000;
const EST = -5 * HOUR;                         // UTC-5: local = UTC + (-5h)
const UTC_MID = Math.floor(1700000000000 / DAY) * DAY + DAY;   // some UTC midnight

function inp(now, over) {
  return Object.assign({ now, lastUserActivityAt: now - 60 * 60000, actsUnattended: true, leashPerDay: 2, halted: false,
    concurrencyFree: true, awayThresholdMs: 15 * 60000, beatIntervalMs: 1 }, over || {});
}

// ---- unconfigured = UTC (back-compat) ----
(function utcDefault() {
  const prev = LocalDay.configure(null);
  A.eq(LocalDay.dayOf(UTC_MID - 1), UTC_MID / DAY - 1, 'unconfigured: the instant before UTC midnight is the previous day');
  A.eq(LocalDay.dayOf(UTC_MID), UTC_MID / DAY, 'unconfigured: UTC midnight starts a new day');
  A.eq(ns.dayOf(UTC_MID), Math.floor(UTC_MID / DAY), 'nightshift.dayOf unchanged when no zone is injected');
  LocalDay.configure(prev);
})();

// ---- explicit tz override + garbage tolerance ----
(function overrides() {
  A.eq(LocalDay.dayOf(UTC_MID + 2 * HOUR, EST), UTC_MID / DAY - 1, 'UTC-5: 02:00 UTC is still 21:00 the previous local day');
  A.eq(LocalDay.dayOf(UTC_MID + 5 * HOUR, EST), UTC_MID / DAY, 'UTC-5: 05:00 UTC is local midnight');
  A.eq(LocalDay.dayOf(UTC_MID + 2 * HOUR, () => { throw new Error('boom'); }), UTC_MID / DAY, 'a throwing offset fn degrades to UTC');
  A.eq(LocalDay.dayOf(UTC_MID + 2 * HOUR, 99 * HOUR), UTC_MID / DAY, 'an out-of-range offset degrades to UTC');
  A.eq(LocalDay.dayOf(UTC_MID + 2 * HOUR, NaN), UTC_MID / DAY, 'a NaN offset degrades to UTC');
  // DST: a per-instant fn — EDT (-4h) before the switch instant, EST (-5h) after.
  const SWITCH = UTC_MID + 6 * HOUR;
  const dst = (t) => (t < SWITCH ? -4 * HOUR : -5 * HOUR);
  A.eq(LocalDay.dayOf(UTC_MID + 3 * HOUR, dst), UTC_MID / DAY - 1, 'DST fn: 03:00 UTC at EDT = 23:00 previous local day');
  A.eq(LocalDay.dayOf(UTC_MID + 4 * HOUR, dst), UTC_MID / DAY, 'DST fn: 04:00 UTC at EDT = local midnight');
  A.eq(LocalDay.dayStartMs(UTC_MID / DAY, EST), UTC_MID + 5 * HOUR, 'dayStartMs: the local midnight of a UTC-5 day is 05:00 UTC');
})();

// ---- the leash rolls at LOCAL midnight (configured zone, as the host does) ----
(function leashRollsAtLocalMidnight() {
  const prev = LocalDay.configure(EST);
  try {
    // two beats on ONE local day that straddle UTC midnight: 15:00 local (20:00 UTC) and 20:00 local (01:00 UTC)
    const t1 = UTC_MID - 4 * HOUR;          // 20:00 UTC = 15:00 local
    let s = ns.recordBeat(ns.fresh(t1), t1);
    const t2 = UTC_MID + 1 * HOUR;          // 01:00 UTC = 20:00 local, SAME local day as t1
    s = ns.recordBeat(s, t2);
    A.eq(s.beatsUsedToday, 2, 'two beats on one local day (straddling UTC midnight) both count against that day');
    const atUtcMidnightPlus2 = UTC_MID + 2 * HOUR;   // 21:00 local — UTC already rolled, local has not
    const d1 = ns.decide(s, inp(atUtcMidnightPlus2));
    A.eq(d1.binding, 'leash', 'UTC midnight passed but the LOCAL day has not: the spent leash still binds');
    A.eq(d1.beatsLeft, 0, 'no beats refilled at UTC midnight');
    const atLocalMidnight = UTC_MID + 5 * HOUR;      // 00:00 local
    const d2 = ns.decide(s, inp(atLocalMidnight));
    A.eq(d2.fire, true, 'local midnight refills the leash');
    A.eq(d2.beatsLeft, 2, 'a full leash on the new local day');
    A.eq(ns.rollDay(s, atLocalMidnight).lastBeatAt, t2, 'lastBeatAt survives the local roll (cadence spans midnight)');
  } finally { LocalDay.configure(prev); }
})();

// ---- the focus keys on the SAME day ----
(function focusSameDay() {
  const prev = LocalDay.configure(EST);
  try {
    const t = UTC_MID - 2 * HOUR;   // 17:00 local
    const inputs = { goal: { text: 'ship the beta', done: 0, total: 0 } };
    const r1 = nf.ensureFocus(nf.fresh(t), inputs, { now: t });
    A.ok(r1.resolved && r1.focus && r1.focus.kind === 'goal', 'first ensureFocus resolves the goal focus');
    const r2 = nf.ensureFocus(r1.state, inputs, { now: UTC_MID + 3 * HOUR });   // 22:00 local, past UTC midnight
    A.eq(r2.resolved, false, 'UTC midnight does not re-resolve the night focus (same local night)');
    const r3 = nf.ensureFocus(r1.state, inputs, { now: UTC_MID + 5 * HOUR + 60000 });   // 00:01 local
    A.eq(r3.resolved, true, 'a new LOCAL day re-resolves the focus');
    A.eq(nf.dayOf(UTC_MID + 3 * HOUR), ns.dayOf(UTC_MID + 3 * HOUR), 'focus day key === leash day key');
  } finally { LocalDay.configure(prev); }
})();

// ---- v1 (UTC-keyed) state is re-keyed on load ----
(function v1Migration() {
  const prev = LocalDay.configure(EST);
  try {
    const lastBeat = UTC_MID + 1 * HOUR;               // 20:00 local on local day (UTC_MID/DAY - 1); UTC day UTC_MID/DAY
    const v1 = { v: 1, day: UTC_MID / DAY, beatsUsedToday: 2, lastBeatAt: lastBeat, haltedAt: 0 };
    const now = UTC_MID + 2 * HOUR;                    // 21:00 local, same local day as the beats
    const loaded = ns.loadEnvelope(JSON.stringify(v1), now);
    A.eq(loaded.day, UTC_MID / DAY - 1, 'v1 UTC day re-keyed to the local day of the newest beat');
    A.eq(ns.beatsLeft(loaded, now, 2), 0, 'upgrade does not refill a leash already spent tonight');
    A.eq(ns.toEnvelope(loaded, now).v, 2, 'persisted envelope is v2');
    // a v1 counter whose beats were from an EARLIER local day rolls normally
    const later = UTC_MID + 5 * HOUR + 1;              // local midnight + 1ms
    A.eq(ns.beatsLeft(ns.loadEnvelope(v1, later), later, 2), 2, 'next local day: a fresh leash');
    // v2 state is never re-keyed
    const v2 = { v: 2, day: 123, beatsUsedToday: 1, lastBeatAt: lastBeat };
    A.eq(ns.normalize(v2, now).day, 123, 'a v2 day is taken as-is');
  } finally { LocalDay.configure(prev); }
  // offset 0: the re-key is an identity
  const p2 = LocalDay.configure(null);
  const v1 = { v: 1, day: UTC_MID / DAY, beatsUsedToday: 1, lastBeatAt: UTC_MID + HOUR };
  A.eq(ns.normalize(v1, UTC_MID + 2 * HOUR).day, UTC_MID / DAY, 'UTC host: v1 re-key is an identity');
  LocalDay.configure(p2);
})();

A.report('nightshift-localday.test');
