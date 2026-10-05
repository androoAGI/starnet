/* node test/nightshift-decline-edge.test.js — night-shift declines are EDGE-TRIGGERED (2026-10-05 audit item 5).

   The 60s tick used to ledger a 'decline' every tick (3,111 of 3,168 live rows were "daily limit used up"), so the
   morning report's newest-200 window held nothing but noise. Proves with a fake clock:
     · 100 identical leash-bound ticks write ONE decline row, not 100
     · a CHANGED reason (leash → present) writes immediately and carries heldTicks/heldBinding for the previous run
     · an unchanged reason is re-logged at most once per declineRepeatMs (default 1h)
     · a fired beat breaks the run: the following cooldown decline is a fresh edge
     · the live decision (applyTick's return / statusDecision) is unaffected — status still sees every tick */
'use strict';
const A = require('./_assert.js');
const { makeNightshiftDriver } = require('../sidecar/nightshift-driver.js');
const ns = require('../sidecar/nightshift.js');

const T0 = 1700000000000, MIN = 60000;

function setup(over) {
  over = over || {};
  let state = ns.fresh(T0);
  let present = false;
  const ledger = [];
  const h = {
    ledger,
    setPresent: (v) => { present = v; },
    setState: (s) => { state = s; },
    get state() { return state; }
  };
  h.driver = makeNightshiftDriver(Object.assign({
    getState: () => state,
    setState: (s) => { state = s; },
    getPosture: () => ({ actsUnattended: true, leashPerDay: over.leashPerDay != null ? over.leashPerDay : 0 }),
    lastActivity: () => (present ? Number.MAX_SAFE_INTEGER / 2 : 0),
    beat: () => Promise.resolve({ delivered: true, title: 'X' }),
    now: () => T0,
    ledger: (e) => ledger.push(e),
    awayThresholdMs: 15 * MIN,
    beatIntervalMs: 45 * MIN
  }, over.deps || {}));
  return h;
}
const declines = (h) => h.ledger.filter(e => e.kind === 'decline');

// ---- a held reason logs once ----
(function heldReasonLogsOnce() {
  const h = setup();   // leash 0 → every tick binds 'leash'
  let lastBinding = null;
  for (let i = 0; i < 50; i++) lastBinding = h.driver.applyTick(T0 + i * MIN).binding;
  A.eq(lastBinding, 'leash', 'every tick still DECIDES leash (the live decision is unaffected)');
  A.eq(declines(h).length, 1, '50 identical leash ticks (under an hour) → ONE decline row');
  A.eq(h.driver._internals.lastDecline().held, 49, 'the 49 suppressed ticks are counted, not lost');
  A.eq(h.driver.statusDecision(T0 + 50 * MIN).binding, 'leash', 'status reads the live decision, not the ledger');
})();

// ---- a changed reason logs immediately, carrying the previous run's tally ----
(function changeLogsWithTally() {
  const h = setup();
  for (let i = 0; i < 10; i++) h.driver.applyTick(T0 + i * MIN);   // leash ×10
  h.setPresent(true);
  h.driver.applyTick(T0 + 10 * MIN);                                // → present
  const ds = declines(h);
  A.eq(ds.length, 2, 'leash → present is an edge: a second row');
  A.eq(ds[1].binding, 'present', 'the new reason is named');
  A.eq(ds[1].heldTicks, 9, 'it carries how long the previous reason held after it was logged');
  A.eq(ds[1].heldBinding, 'leash', '…and which reason that was');
  h.setPresent(false);
  h.driver.applyTick(T0 + 11 * MIN);                                // → back to leash
  A.eq(declines(h).length, 3, 'returning to an earlier reason is also an edge');
})();

// ---- an unchanged reason is re-logged at most once per hour ----
(function hourlyHeartbeat() {
  const h = setup();
  for (let i = 0; i <= 125; i++) h.driver.applyTick(T0 + i * MIN);   // 0..125 min, all leash
  const ds = declines(h);
  A.eq(ds.length, 3, 'a reason held for ~2h is re-logged hourly (t=0, 60, 120 min)');
  A.eq(ds.map(d => d.ts - T0), [0, 60 * MIN, 120 * MIN], 'at the hour marks');
  A.eq(ds[1].heldTicks, 59, 'each heartbeat carries the ticks folded since the last row');
  const h2 = setup({ deps: { declineRepeatMs: 10 * MIN } });
  for (let i = 0; i < 30; i++) h2.driver.applyTick(T0 + i * MIN);
  A.eq(declines(h2).length, 3, 'declineRepeatMs is injectable (10 min → 3 rows in 30 min)');
})();

// ---- a fired beat breaks the run ----
(async function beatBreaksRun() {
  const h = setup({ leashPerDay: 3 });
  h.setPresent(true);
  for (let i = 0; i < 5; i++) h.driver.applyTick(T0 + i * MIN);      // present ×5 → 1 row
  h.setPresent(false);
  const r = h.driver.applyTick(T0 + 5 * MIN);
  A.eq(r.fired, true, 'away + leash left → a beat fires');
  const beat = h.ledger.find(e => e.kind === 'beat');
  A.eq(beat.heldTicks, 4, 'the beat row carries the folded present ticks');
  await new Promise(res => setImmediate(res));
  h.driver.applyTick(T0 + 6 * MIN);                                  // cooldown
  h.driver.applyTick(T0 + 7 * MIN);                                  // cooldown (suppressed)
  const ds = declines(h);
  A.eq(ds.map(d => d.binding), ['present', 'cooldown'], 'after a beat the first cooldown decline is a fresh edge; the repeat is folded');
})().then(() => A.report('nightshift-decline-edge.test'));
