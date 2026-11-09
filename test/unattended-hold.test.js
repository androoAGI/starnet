/* node test/unattended-hold.test.js — THE UNATTENDED HOLD (cost fix W3.1): the window reserve and the 24-hour rail, keyed on
   who started the run (sidecar/unattended-admission.js admit), and the one-resolver wiring every unattended starter shares.
   Pure: fixed clocks and literal readings, no sidecar. The real-sidecar proof (0 provider calls and one truthful ledger row
   per held start, the user's own message running, RESUME, a restart) is test/unattended-hold.e2e.test.js.

   Written before the resolver existed (W3.1 step 3): on the base every hold assertion below fails, because nothing
   there holds anything — `admit` falls back to "always admit" so the run reports each missing hold by name. */
'use strict';
const A = require('./_assert.js');
const UA = require('../sidecar/unattended-admission.js');

const fn = (name, fallback) => (typeof UA[name] === 'function' ? UA[name] : fallback);
const admit = fn('admit', () => ({ admit: true }));
const say = fn('say', () => '');
const weigh = fn('weigh', () => NaN);
const railTally = fn('railTally', () => ({ tokens: 0, from: null, liftsAt: null }));
const tokensPerStart = fn('tokensPerStart', () => null);
const thresholds = fn('thresholds', () => ({}));
const isUnattended = fn('isUnattended', () => false);
const T = UA.THRESHOLDS || {};

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const MIN = 60000, HOUR = 3600000;
const SOURCE = 'x-codex-* response headers';
// one sign-in's reading, as sub-usage.js keeps it (usedPct 0-100, resetsAt / seenAt ms epoch)
const reading = (pct, o) => {
  const x = o || {};
  return { account: x.account || 'primary', source: SOURCE,
    entry: x.entry === null ? null : { seenAt: x.seenAt != null ? x.seenAt : NOW - MIN,
      windows: x.windows || [{ id: 'primary', label: '5-hour', usedPct: pct, resetsAt: x.resetsAt != null ? x.resetsAt : NOW + 2 * HOUR, status: '', minutes: 300 }] } };
};
const ask = (origin, readings, extra) => admit(Object.assign({ origin, provider: 'codex', signIn: true, readings, rail: { tokens: 0 }, now: NOW, thresholds: T }, extra || {}));

// ---- the thresholds live in one place ----
(function onePlace() {
  A.eq([T.windowPct, T.staleMs, T.railTokens, T.railMs], [90, 12 * HOUR, 2000000, 24 * HOUR], 'THRESHOLDS: 90% of a window, a 12 h freshness bound, a 2M weighted rail over 24 h');
  A.ok(Object.isFrozen(T), 'and they are frozen: one table, read by every check');
  A.eq([thresholds({}).windowPct, thresholds({}).railTokens], [90, 2000000], 'no override: the defaults (ON by default for unattended work)');
  A.eq([thresholds({ windowPct: '0', railTokens: 'off' }).windowPct, thresholds({ windowPct: '0', railTokens: 'off' }).railTokens], [0, 0], 'the switches: 0 or off turns either one off');
  A.eq([thresholds({ windowPct: '95', railTokens: '5000000' }).windowPct, thresholds({ windowPct: '95', railTokens: '5000000' }).railTokens], [95, 5000000], 'a number sets it');
  A.eq([thresholds({ windowPct: 'lots', railTokens: '-3' }).windowPct, thresholds({ windowPct: 'lots', railTokens: '-3' }).railTokens], [90, 2000000], 'a value that is not a number keeps the default');
  A.eq(UA.ORIGINS, ['nightshift', 'routine', 'loop', 'workshop'], 'the unattended starters: an away-shift beat, a routine fire, a loop tick, an away build');
})();

// ---- who started the run: a person's start is never held, whatever the reading ----
(function whoStarted() {
  for (const origin of [undefined, '', 'person', 'manual', 'directive', 'schedule', 'NIGHTSHIFT']) {
    A.eq(ask(origin, [reading(99)]).admit, true, 'a start no driver made (' + JSON.stringify(origin) + ') is never held, even at 99%');
    A.eq(isUnattended(origin), false, JSON.stringify(origin) + ' is not an unattended origin');
  }
  for (const origin of ['nightshift', 'routine', 'loop', 'workshop']) {
    const d = ask(origin, [reading(92)]);
    A.eq([d.admit, d.binding], [false, 'window-reserve'], origin + ': held at 92% with the reset ahead');
    A.eq(d.why, { provider: 'codex', account: 'primary', window: '5-hour', usedPct: 92, resetsAt: NOW + 2 * HOUR, seenAt: NOW - MIN, source: SOURCE },
      origin + ': the hold names the reading, its sign-in, when it was read, its source and the reset');
    A.ok(isUnattended(origin), origin + ' is unattended');
  }
})();

// ---- the window reserve: only a real, fresh reading at or above the line with its reset ahead holds ----
(function windowReserve() {
  A.eq(ask('routine', [reading(89)]).admit, true, '89%: admitted');
  A.eq(ask('routine', [reading(89.9)]).admit, true, '89.9%: admitted');
  A.eq(ask('routine', [reading(90)]).admit, false, '90%: held (at or above the line)');
  A.eq(ask('routine', [reading(100)]).admit, false, '100%: held');
  A.eq(ask('routine', [reading(92, { resetsAt: NOW })]).admit, true, 'the reset has come: admitted');
  A.eq(ask('routine', [reading(92, { resetsAt: NOW - 1 })]).admit, true, 'the reset has passed: admitted');
  A.eq(ask('routine', [reading(92, { entry: null })]).admit, true, 'no reading: admitted (never held on a guess)');
  A.eq(ask('routine', []).admit, true, 'no sign-in to read: admitted');
  A.eq(ask('routine', undefined).admit, true, 'readings unknown: admitted');
  A.eq(ask('routine', [reading(92, { seenAt: NOW - 12 * HOUR - 1 })]).admit, true, 'read more than 12 h ago: stale, admitted');
  A.eq(ask('routine', [reading(92, { seenAt: NOW - 12 * HOUR })]).admit, false, 'read exactly 12 h ago: still fresh, held');
  A.eq(ask('routine', [reading(92, { seenAt: NOW + MIN })]).admit, true, 'a reading from the future (another clock): unproven, admitted');
  A.eq(ask('routine', [reading(null)]).admit, true, 'a window with no percentage (an older CLI): admitted');
  const two = [{ id: 'five_hour', label: '5-hour', usedPct: 40, resetsAt: NOW + HOUR, minutes: 300 }, { id: 'seven_day', label: 'week', usedPct: 95, resetsAt: NOW + 3 * 24 * HOUR, minutes: 10080 }];
  const w = ask('loop', [reading(0, { windows: two })]);
  A.eq([w.admit, w.why && w.why.window, w.why && w.why.usedPct, w.why && w.why.resetsAt], [false, 'week', 95, NOW + 3 * 24 * HOUR], 'any full window holds: the week at 95% holds while the 5-hour has room');
  const both = [{ id: 'five_hour', label: '5-hour', usedPct: 91, resetsAt: NOW + HOUR, minutes: 300 }, { id: 'seven_day', label: 'week', usedPct: 93, resetsAt: NOW + 2 * 24 * HOUR, minutes: 10080 }];
  A.eq((ask('loop', [reading(0, { windows: both })]).why || {}).window, 'week', 'two full windows: the hold names the one that frees the sign-in last');
  // subscription stacking: a run rotates to the next sign-in when one is spent, so the reserve holds only when EVERY live sign-in is full
  A.eq(ask('routine', [reading(95), reading(40, { account: 'acct-2' })]).admit, true, 'a second sign-in with room: admitted');
  A.eq(ask('routine', [reading(95), reading(92, { account: 'acct-2', entry: null })]).admit, true, 'a second sign-in with no reading: admitted');
  const all = ask('routine', [reading(95, { resetsAt: NOW + 3 * HOUR }), reading(92, { account: 'acct-2', resetsAt: NOW + HOUR })]);
  A.eq([all.admit, all.why && all.why.account, all.why && all.why.resetsAt], [false, 'acct-2', NOW + HOUR], 'every sign-in full: held, naming the one whose reset frees a sign-in first');
  A.eq(ask('routine', [reading(99)], { thresholds: thresholds({ windowPct: '0' }) }).admit, true, 'the reserve switched off: admitted');
  A.eq(ask('routine', [reading(96)], { thresholds: thresholds({ windowPct: '97' }) }).admit, true, 'a 97% line: 96% is admitted');
})();

// ---- the weight: input-eq, the per-run subscription seatbelt's weighing (loop.js) — a cache re-read at 1/10 ----
(function weight() {
  A.eq(weigh({ uncachedIn: 1000, cacheWrite: 200, cacheRead: 5000, out: 300, reasoning: 100 }), 2000, 'fresh input + cache write + output at full weight, a cache read at 1/10, reasoning inside output');
  A.eq(weigh({ usageMissing: true }), 0, 'a call whose usage never arrived weighs nothing it can prove');
  A.eq(weigh(null), 0, 'no receipt: 0');
})();

// ---- the rail: unattended receipts only, the trailing 24 h, since the last RESUME ----
(function rail() {
  const r = (at, origin, uncachedIn, cacheRead) => ({ v: 1, at, provider: 'codex', account: 'primary', uncachedIn, cacheRead: cacheRead || 0, cacheWrite: 0, out: 0, origin });
  const recs = [
    r(NOW - 25 * HOUR, 'routine', 900000),            // older than 24 h: rolled off
    r(NOW - 20 * HOUR, 'routine', 800000),
    r(NOW - 10 * HOUR, 'nightshift', 700000, 1000000), // 700k + 100k
    r(NOW - 5 * HOUR, undefined, 5000000),             // the Commander's own run: never counted
    r(NOW - 2 * HOUR, 'loop', 500000),
    r(NOW + MIN, 'loop', 999999)                       // after now: not yet
  ];
  const t = railTally(recs, NOW, null, T);
  A.eq(t.tokens, 2100000, 'the trailing 24 h of unattended work, weighted: 800k + 800k + 500k (a person\'s 5M is not counted)');
  A.eq(t.liftsAt, NOW - 20 * HOUR + 24 * HOUR, 'with nothing new while held, the count falls under 2M when the 20 h-old fire rolls off');
  const d = ask('nightshift', [reading(10)], { rail: t });
  A.eq([d.admit, d.binding], [false, 'unattended-rail'], 'at 2.1M weighted in 24 h unattended starts pause');
  A.eq(d.why, { tokens: 2100000, limit: 2000000, since: NOW - 20 * HOUR, liftsAt: NOW + 4 * HOUR }, 'the pause names the count, the rail, the oldest call it holds and when it lifts on its own');
  const later = ask('nightshift', [reading(10)], { now: NOW + 30000, rail: railTally(recs, NOW + 30000, null, T) });
  A.eq([later.why, say(later)], [d.why, say(d)], 'half a minute on, nothing new: the same pause in the same words (ledgered once, never once per tick)');
  A.eq(ask('nightshift', [reading(10)], { rail: { tokens: 1999999 } }).admit, true, 'under the rail: admitted');
  A.eq(ask('manual', [reading(10)], { rail: t }).admit, true, 'a person\'s start is never paused by the rail');
  A.eq(ask('routine', [reading(10)], { rail: t, signIn: false }).admit, true, 'a route that cannot sign in (a metered key, a local model) is left to its own caps');
  const resumed = railTally(recs, NOW, NOW - 3 * HOUR, T);
  A.eq([resumed.tokens, resumed.from], [500000, NOW - 3 * HOUR], 'RESUME starts a fresh count: only what ran after it counts');
  A.eq(ask('routine', [reading(10)], { rail: resumed }).admit, true, 'and the starts go again');
  A.eq(ask('routine', [reading(10)], { rail: t, thresholds: thresholds({ railTokens: '0' }) }).admit, true, 'the rail switched off: admitted');
  A.eq(ask('routine', [reading(95)], { rail: t }).binding, 'window-reserve', 'both bind: the provider\'s own reading is named first');
})();

// ---- the words: the reading, its source and the reset, or the count and how it resumes ----
(function words() {
  const w = say(ask('nightshift', [reading(92)]));
  A.ok(/codex/.test(w) && /5-hour/.test(w) && /92%/.test(w) && w.indexOf(SOURCE) >= 0 && /2026-11-09 09:59 UTC/.test(w) && /2026-11-09 12:00 UTC/.test(w) && /10%/.test(w),
    'the window hold says the provider, the window, the percentage, its source, when it was read, the reset and the share kept: ' + w);
  const r = say({ admit: false, binding: 'unattended-rail', why: { tokens: 2100000, limit: 2000000, since: NOW - 24 * HOUR, liftsAt: NOW + 4 * HOUR } });
  A.ok(/2\.1M/.test(r) && /2M/.test(r) && /re-arm/i.test(r) && /2026-11-09 14:00 UTC/.test(r), 'the rail pause says the count, the rail, RESUME (re-arm) and when it lifts on its own: ' + r);
  A.eq(say({ admit: true }), '', 'an admitted start says nothing');
})();

// ---- tokens per beat / per fire: one start's weighted receipts, averaged over its newest starts ----
(function perStart() {
  const r = (at, start, uncachedIn, origin, ref) => ({ v: 1, at, provider: 'codex', account: 'primary', uncachedIn, cacheRead: 0, cacheWrite: 0, out: 0, origin: origin || 'routine', ref: ref || 'job-1', start });
  const recs = [r(1, 's1', 100000), r(2, 's1', 50000), r(3, 's2', 250000), r(4, 's3', 999, 'routine', 'job-2'), r(5, 's4', 5, 'loop', 'job-1'), r(6, 's5', 400000)];
  A.eq(tokensPerStart(recs, { origin: 'routine', ref: 'job-1' }), { tokens: 266667, starts: 3 }, 'mean of the fires of job-1: (150k + 250k + 400k) / 3');
  A.eq(tokensPerStart(recs, { origin: 'routine', ref: 'job-1', exclude: 's5' }), { tokens: 200000, starts: 2 }, 'a fire still running is not counted');
  A.eq(tokensPerStart(recs, { origin: 'routine', ref: 'job-1', exclude: new Map([['s5', 1], ['s9', 1]]) }), { tokens: 200000, starts: 2 }, '...nor any of the starts the host has running');
  A.eq(tokensPerStart(recs, { origin: 'routine', ref: 'job-1', last: 1 }), { tokens: 400000, starts: 1 }, 'the newest starts only');
  A.eq(tokensPerStart(recs, { origin: 'nightshift', ref: 'agent' }), null, 'no start on record: no number');
})();

// ---- ONE RESOLVER: every unattended starter asks the same host check, which is the only caller of admit() ----
const { readSidecarSource } = require('./helpers/source');
const SRC = readSidecarSource();
const sliceOr = (header, max) => { try { const b = A.fnBody(SRC, header); return (b.length > 40 && b.length < max) ? b : ''; } catch (_) { return ''; } };
(function oneResolver() {
  A.eq((SRC.match(/UnattendedAdmission\.admit\(/g) || []).length, 1, 'admit() is called from one place in the sidecar');
  const hold = sliceOr('function unattendedHold(', 4000);
  A.ok(/UnattendedAdmission\.admit\(/.test(hold), 'that one place is the host\'s unattendedHold');
  A.ok(/unattendedHold\('nightshift'/.test(sliceOr('function nightshiftPrecheck()', 7000)), 'an away-shift beat: the night shift\'s pre-spend precheck asks it');
  const cron = SRC.slice(SRC.indexOf('makeCronDriver({'), SRC.indexOf('makeCronDriver({') + 30000);
  A.ok(/admitUnattended: \(job, route\) => holdRoutineFire\(job, route\)/.test(cron), 'a routine fire: the cron driver is handed the hold');
  A.ok(/unattendedHold\(job && job\.meta && job\.meta\.workshop === true \? 'workshop' : 'routine'/.test(sliceOr('function holdRoutineFire(', 4000)), '...which names an away-workshop shift an away build');
  const fire = sliceOr('function fireJob(', 40000);
  const at = fire.indexOf('admitUnattended(job'), run = fire.indexOf('const runId = newId();');
  A.ok(at > 0 && run > at, 'the fire asks before its run id, lease, cron.fire or crate exist');
  A.ok(/unattendedHold\('loop'/.test(sliceOr('function loopPrecheck(', 6000)), 'a loop tick: the loop\'s precheck (and the LOOPS window) asks it');
  const ns = sliceOr('async function runNightshiftActShift(', 60000), ws = sliceOr('async function runWorkshopShift(', 40000);
  A.ok(/unattendedHold\(opts\.origin/.test(ns) && ns.indexOf('unattendedHold(opts.origin') < ns.indexOf('runImplementBuild('), 'an away build chained after an unattended beat asks before it builds');
  A.ok(/unattendedHold\(o\.origin/.test(ws) && ws.indexOf('unattendedHold(o.origin') < ws.indexOf('runImplementBuild('), 'an away build chained after an unattended shift asks before it builds');
  // every unattended start runs in the origin scope its receipts are stamped from (the rail counts them; a person's never)
  A.ok(/beat: \(o\) => asUnattended\('nightshift'/.test(SRC), 'the driver\'s beat runs in the nightshift scope (a beat forced by hand does not)');
  A.ok(/asUnattended\(first && first\.indexOf\(WORKSHOP_MARK\) === 0 \? 'workshop' : 'routine'/.test(cron), 'a scheduled fire runs in the routine (or workshop) scope (Run Now does not)');
  A.ok(/runOnce: \(opts\) => asUnattended\('loop'/.test(SRC), 'a loop iteration runs in the loop scope');
  const hop = sliceOr('function lineHopRun(', 1500);
  A.ok(/trigger === 'schedule'/.test(hop) && /asUnattended\('routine'/.test(hop) && /LineRunner\.makeLineRunner\(\{ chain: chainRunner, runOnce: lineHopRun,/.test(SRC),
    'a work-line hop of a scheduled fire runs in its fire\'s routine scope (a Run Now, channel or step-test hop does not)');
  A.ok(/railResumed = resumeUnattendedRail\(\)/.test(sliceOr('async function handleAutonomyPosture(', 12000)), 'RESUME is the posture re-arm (resumeHalt), the control that turns unattended work on');
})();

A.report('unattended-hold.test');
