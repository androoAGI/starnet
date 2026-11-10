/* node test/unattended-hold.test.js — THE UNATTENDED HOLD (cost fix W3.1): the window reserve and the 24-hour rail, keyed on
   who started the run (sidecar/unattended-admission.js admit), and the one-resolver wiring every unattended starter shares.
   Pure: fixed clocks and literal readings, no sidecar. The real-sidecar proof (0 provider calls and one truthful ledger row
   per held start, the user's own message running, RESUME, a restart) is test/unattended-hold.e2e.test.js.

   Written before the resolver existed (W3.1 step 3): on the base every hold assertion below fails, because nothing
   there holds anything — `admit` falls back to "always admit" so the run reports each missing hold by name.

   The review round (W3.1 blockers) added the behavior below the wiring, each on the REAL code it names, red on the first cut:
     B1 RESUME is a re-arm of a posture that turns unattended work ON (SMALL JOBS / FREE), never WAIT, SUGGEST or CHECK WITH ME;
     B2 a fire a PERSON asked for (routine.manage run_now in their own run) is admitted and runs outside the unattended scope —
        the real cron-store + cron-driver, and the real cron wrapper lifted out of index.js;
     B3 a routine line's hops are stamped with the ROUTINE's id, so tokens per fire counts the whole line (the real wrapper,
        lineHopRun and usage receipts);
     B4 a line trigger's fire and a SEND TO of unattended work are held by the same host check (the real trigger and
        hand-off runners, and the real holdLineStart / unattendedStartOf / holdRoutineFire slices). */
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
  A.eq(UA.ORIGINS, ['nightshift', 'routine', 'loop', 'workshop', 'trigger'], 'the unattended starters: an away-shift beat, a routine fire, a loop tick, an away build, a line trigger\'s fire');
})();

// ---- who started the run: a person's start is never held, whatever the reading ----
(function whoStarted() {
  for (const origin of [undefined, '', 'person', 'manual', 'directive', 'schedule', 'NIGHTSHIFT']) {
    A.eq(ask(origin, [reading(99)]).admit, true, 'a start no driver made (' + JSON.stringify(origin) + ') is never held, even at 99%');
    A.eq(isUnattended(origin), false, JSON.stringify(origin) + ' is not an unattended origin');
  }
  for (const origin of ['nightshift', 'routine', 'loop', 'workshop', 'trigger']) {
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

// ---- the panel's words: the AUTONOMY panel and its decision trail name the reading or the count in LOCAL time ----
(function panelWords() {
  const NR = require('../frontend/app/nightreport.js');
  const why = { provider: 'codex', account: 'primary', window: '5-hour', usedPct: 92, resetsAt: NOW + 2 * HOUR, seenAt: NOW - MIN, source: SOURCE };
  const base = { active: true, away: true, beatsUsedToday: 1, leashPerDay: 3 };
  const held = NR.panelModel({ status: Object.assign({}, base, { binding: 'window-reserve', hold: { binding: 'window-reserve', why, keptPct: 10 } }), tzOffsetMin: -300, nowMs: NOW });
  A.ok(/codex/.test(held.why) && /5-hour/.test(held.why) && /92%/.test(held.why) && held.why.indexOf(SOURCE) >= 0 && /4:59 AM/.test(held.why) && /7:00 AM/.test(held.why) && /last 10%/.test(held.why),
    'the panel names the provider, the window, the percentage, its source, when it was read and the reset, in local time: ' + held.why);
  A.eq(held.nextEligibleText, 'not before 7:00 AM — when the usage window resets', 'the next job: the window\'s own reset');
  const weekly = NR.panelModel({ status: Object.assign({}, base, { binding: 'window-reserve', hold: { binding: 'window-reserve', why: Object.assign({}, why, { window: 'weekly', resetsAt: NOW + 3 * 24 * HOUR }) } }), tzOffsetMin: -300, nowMs: NOW });
  A.ok(/Nov 12, 5:00 AM/.test(weekly.nextEligibleText) && /the rest is kept/.test(weekly.why), 'a reset days away carries its date, never a bare clock (and no kept share: the plain words): ' + weekly.nextEligibleText);
  const rail = NR.panelModel({ status: Object.assign({}, base, { binding: 'unattended-rail', hold: { binding: 'unattended-rail', why: { tokens: 2100000, limit: 2000000, since: NOW - 20 * HOUR, liftsAt: NOW + 4 * HOUR } } }), tzOffsetMin: -300, nowMs: NOW });
  A.ok(/2\.1M/.test(rail.why) && /2M/.test(rail.why) && /re-arm autonomy/.test(rail.why) && /9:00 AM/.test(rail.why), 'the rail pause says the count, the rail, RESUME and when it lifts on its own: ' + rail.why);
  // B1: only a rung that turns unattended work on resumes it, so the words name those two, never "an ON ITS OWN rung"
  A.ok(/press SMALL JOBS or FREE under ON ITS OWN/.test(rail.why) && !/an ON ITS OWN rung/.test(rail.why), 'the rail pause names the rungs that resume it (SMALL JOBS or FREE): ' + rail.why);
  A.ok(/press SMALL JOBS or FREE under ON ITS OWN/.test(NR.panelModel({ status: Object.assign({}, base, { binding: 'unattended-rail' }), tzOffsetMin: 0 }).why), '...in the plain phrase too (an older sidecar with no count)');
  const resumedRow = NR.trailLine({ ts: NOW, kind: 'note', source: 'nightshift', reason: 'unattended-rail:resumed', detail: { tokens: 2100000, limit: 2000000, note: 'autonomy re-armed: the unattended rail counts again from now' } }, -300);
  A.ok(/noted/.test(resumedRow) && /autonomy re-armed: the unattended rail counts again from now/.test(resumedRow) && !/unattended-rail:resumed/.test(resumedRow), 'the RESUME row reads its own words in the trail, never its reason code: ' + resumedRow);
  A.eq(rail.nextEligibleText, 'when you re-arm autonomy, or 9:00 AM', 'the next job: a re-arm, or the oldest use rolling off');
  A.ok(/kept for you/.test(NR.panelModel({ status: Object.assign({}, base, { binding: 'window-reserve' }), tzOffsetMin: 0 }).why), 'an older sidecar with no hold: the plain phrase, never a made-up number');
  const row = NR.trailLine({ ts: NOW, kind: 'decline', binding: 'window-reserve', detail: why }, -300);
  A.ok(/declined/.test(row) && /92%/.test(row) && /7:00 AM/.test(row), 'a held beat\'s ledger row reads its own reading in the trail: ' + row);
  A.eq(NR.panelModel({ status: Object.assign({}, base, { tokensPerBeat: { tokens: 152400, starts: 3 } }), tzOffsetMin: 0 }).perJobText, '~152k weighted tokens a job', 'tokens per beat: one short stat on the panel');
  A.eq(NR.panelModel({ status: base, tzOffsetMin: 0 }).perJobText, '', '...absent until a beat is recorded');
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
  A.ok(/scope = \{ origin: first && first\.indexOf\(WORKSHOP_MARK\) === 0 \? 'workshop' : 'routine'/.test(cron) && /return asked \? unattendedScope\.exit\(work\) : asUnattended\(scope\.origin, scope\.ref, work, opts && opts\.runId\)/.test(cron),
    'a scheduled fire runs in the routine (or workshop) scope; a fire a person asked for runs outside it (Run Now calls runOnce directly)');
  A.ok(/runOnce: \(opts\) => asUnattended\('loop'/.test(SRC), 'a loop iteration runs in the loop scope');
  const hop = sliceOr('function lineHopRun(', 1500);
  A.ok(/trigger === 'schedule'/.test(hop) && /asUnattended\(sc\.origin, sc\.ref, \(\) => runOnce\(o\), sc\.start\)/.test(hop) && /LineRunner\.makeLineRunner\(\{ chain: chainRunner, runOnce: lineHopRun,/.test(SRC),
    'a work-line hop of a scheduled fire re-enters the scope its fire recorded (a Run Now, channel or step-test hop does not)');
  // B1: RESUME is a re-arm of a posture that turns unattended work on, never any posture write that asks resumeHalt
  A.ok(/if \(resumeRequested && \(commanderPosture\.summary\(\) \|\| \{\}\)\.actsUnattended === true\) railResumed = resumeUnattendedRail\(\)/.test(sliceOr('async function handleAutonomyPosture(', 14000)),
    'RESUME lifts the rail only on a posture that turns unattended work on (SMALL JOBS or FREE): WAIT, SUGGEST and CHECK WITH ME resume nothing');
  // B2: run_now asked from a person's own run marks its fire as theirs (no unattended start is running around the call)
  const rtr = SRC.indexOf('triggerRoutine: async (id) => {'), trig = rtr >= 0 ? SRC.slice(rtr, rtr + 600) : '';
  A.ok(/const personAsked = !unattendedNow\(\);/.test(trig) && /cronStore\.triggerJob\(jobs, id, \{ [^}]*personAsked: personAsked \}\)/.test(trig), 'routine.manage run_now: a person\'s own run marks the fire it makes due as theirs');
  // B4: a line's own start asks the same host check, for each entry the line can start on
  A.ok(/unattendedHold\(origin, \{ provider:/.test(sliceOr('function holdLineStart(', 3000)), 'a line\'s own start (a trigger\'s fire, a SEND TO of unattended work) asks unattendedHold');
})();

// ---- B4 THE WIRING index.js really passes: lifted out of the two runner calls and run, so a dropped or renamed dep fails here ----
(function lineWiring() {
  const { callRegion, liftValues } = require('./helpers/source');
  const calls = [];
  const scope = {
    holdLineStart: (origin, lineId) => { calls.push(['hold', origin, lineId]); return origin === 'routine' && lineId === 'L-held' ? { say: 'held words' } : null; },
    asUnattended: (origin, ref, fn, start) => { calls.push(['scope', origin, ref, start]); return fn(); },
    unattendedStartOf: (rec) => { calls.push(['startOf', rec && rec.streamId]); return { origin: 'routine', ref: 'routine-7', start: 'run-1' }; }
  };
  let trg = {}, hof = {};
  try { trg = liftValues(callRegion(SRC, 'const triggerRunner = makeTriggerRunner({', '\n});'), ['unattendedHold', 'asUnattended'], scope); } catch (e) { A.ok(false, 'the trigger runner call could not be lifted: ' + e.message); }
  try { hof = liftValues(callRegion(SRC, 'handoffRunner = makeHandoffRunner({', '\n});'), ['startOf', 'unattendedHold', 'asUnattended'], scope); } catch (e) { A.ok(false, 'the hand-off runner call could not be lifted: ' + e.message); }
  if (typeof trg.unattendedHold === 'function' && typeof trg.asUnattended === 'function') {
    A.eq(trg.unattendedHold({ id: 'trg-1', lineId: 'L1' }), null, 'a trigger with room: no hold');
    A.eq(trg.asUnattended({ id: 'trg-1', lineId: 'L1' }, 'trigger-s1', () => 'ran'), 'ran', 'a trigger\'s fire runs its work');
    A.eq(calls.splice(0), [['hold', 'trigger', 'L1'], ['scope', 'trigger', 'trg-1', 'trigger-s1']], 'a trigger\'s fire is asked as origin "trigger" on its own line, and runs as that trigger\'s start (its stream is the start)');
  } else A.ok(false, 'the trigger runner is handed the unattended hold and the scope (unattendedHold, asUnattended)');
  if (typeof hof.startOf === 'function' && typeof hof.unattendedHold === 'function' && typeof hof.asUnattended === 'function') {
    const start = hof.startOf({ streamId: 'cron-run-1' });
    A.eq(hof.unattendedHold(start, 'L-held'), 'held words', 'a SEND TO of a routine fire\'s job is asked on the target line, as that fire\'s origin, and says the hold');
    A.eq(hof.unattendedHold(null, 'L-held'), null, '...a person\'s job (no start) is asked nothing that can hold it');
    A.eq(hof.asUnattended(start, () => 'ran'), 'ran', 'an admitted hand-off runs its work');
    A.eq(calls.splice(0), [['startOf', 'cron-run-1'], ['hold', 'routine', 'L-held'], ['hold', null, 'L-held'], ['scope', 'routine', 'routine-7', 'run-1']],
      'the start is read from the shipped job, the hold asked on the target line, and the hand-off runs in the start that shipped it (same start key)');
  } else A.ok(false, 'the hand-off runner is handed who started the job, the unattended hold and the scope (startOf, unattendedHold, asUnattended)');
})();

// ---- the existing cards: the postures that turn unattended work on say so; tokens per beat and per fire ride existing lines ----
(function cards() {
  const fs = require('fs'), path = require('path');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  const rt = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'routines.js'), 'utf8');
  const at = ui.indexOf('const STATION_POSTURES = [');
  const postures = at >= 0 ? ui.slice(at, ui.indexOf('];', at)) : '';
  const blurb = id => { const m = new RegExp("id: '" + id + "'[^\\n]*\\n\\s*blurb: '([^']*)'").exec(postures); return m ? m[1] : ''; };
  A.ok(/Turns on unattended work/.test(blurb('balanced')) && /Turns on unattended work/.test(blurb('open')) && !/unattended/.test(blurb('careful')),
    'LET IT WORK and FULL POWER say they turn on unattended work (CHECK WITH ME, which does not, says nothing of it)');
  A.ok(/m\.perJobText/.test(ui), 'the AUTONOMY panel carries tokens per beat on its existing job-limit line');
  const si = rt.indexOf('function spendLine(j)'), spend = si >= 0 ? rt.slice(si, rt.indexOf('\n    }', si)) : '';
  A.ok(/perFireLine\(j\)/.test(spend) && /' · last ' \+ lastResult\(j\) \+ spendLine\(j\)/.test(rt) && /j\.tokensPerFire/.test(rt), 'the routine row carries tokens per fire beside its spend');
  A.ok(/tokensPerBeat: unattendedPerStart\('nightshift'/.test(SRC) && /tokensPerFire: t/.test(SRC), 'both numbers are read from the receipts the rail counts');
})();

/* ======================= THE BEHAVIOR UNDER THE WIRING (the W3.1 review round) =======================
   Each section runs the real code it names: sidecar modules required as they are, index.js functions sliced out of the real
   source (sidecarFunctionSource) or lifted out of the real call (liftValues), built over stand-ins for only the names they read. */
const { readSidecarIndex, sidecarFunctionSource, callRegion, liftValues } = require('./helpers/source');
const IDX = readSidecarIndex();
const settle = (ms) => new Promise(r => setTimeout(r, ms || 10));
// one index.js function, built over the names it reads; null when the sidecar has none by that name
const build = (name, deps) => {
  const src = sidecarFunctionSource(name);
  if (!src) return null;
  return new Function(...Object.keys(deps), src + '\nreturn ' + name + ';')(...Object.values(deps));   // eslint-disable-line no-new-func
};
// the host's scope machinery (index.js asUnattended / unattendedNow over its AsyncLocalStorage), shared by the sections below
const host = (function () {
  const { AsyncLocalStorage } = require('async_hooks');
  const unattendedScope = new AsyncLocalStorage();
  const unattendedLive = new Map();
  const cronItems = new Map();
  const asUnattended = build('asUnattended', { unattendedScope, unattendedLive, crypto: require('crypto') });
  const unattendedNow = build('unattendedNow', { unattendedScope, unattendedLive });
  return { unattendedScope, unattendedLive, cronItems, asUnattended, unattendedNow };
})();

// ---- B3 + B2: whose a fire's work is — the real cron wrapper (lifted out of makeCronDriver), lineHopRun and the usage receipts ----
async function fireScope() {
  const { unattendedScope, unattendedLive, cronItems, asUnattended, unattendedNow } = host;
  if (typeof asUnattended !== 'function') { A.ok(false, 'asUnattended is in the sidecar'); return; }
  // the receipts' scope read, exactly as index.js hands it to usage-receipts.js
  const scopeRead = liftValues(callRegion(IDX, "require('./usage-receipts.js').makeUsageReceipts({", 'onRecord:'), ['scope'], { unattendedScope, unattendedLive, unattendedNow }).scope;
  if (typeof scopeRead !== 'function') { A.ok(false, 'the usage receipts are handed the scope read'); return; }
  let at = 1;
  const receipts = require('../sidecar/usage-receipts.js').makeUsageReceipts({ clock: { now: () => at++ }, scope: scopeRead });
  const model = receipts.wrap({ stream: async function* (req) { yield { type: 'usage', usage: { prompt_tokens: req.tokens, completion_tokens: 0 } }; yield { type: 'done' }; } }, { provider: 'codex', account: 'primary' });
  const seen = [];
  // the host's run: one model call of o.tokens fresh input (its receipt reads who started it as the call starts)
  const runOnce = async (o) => { seen.push(o); for await (const ev of model.stream({ model: 'm', runId: o.runId, tokens: o.tokens })) { if (!ev) break; } return { ok: true }; };
  const wrapper = liftValues(callRegion(IDX, 'const cronDriver = makeCronDriver({', '\n});'), ['runOnce'], { WORKSHOP_MARK: '[[WORKSHOP-SHIFT]]', cronItems, asUnattended, unattendedScope,
    runsAsCommand: require('../sidecar/routine-identity.js').runsAsCommand, runWorkshopShift: () => Promise.resolve({}), runSlashRoutine: () => Promise.resolve({}),
    runTable: { admit: () => ({ release() {} }) }, runOnce }).runOnce;
  const lineHopRun = build('lineHopRun', { cronItems, asUnattended, runOnce });
  if (typeof wrapper !== 'function' || typeof lineHopRun !== 'function') { A.ok(false, 'the cron wrapper and lineHopRun are in the sidecar'); return; }
  const fire = { messages: [{ role: 'user', content: 'tidy the inbox' }], agentId: 'agent', cronJobId: 'routine-7', isTask: true };

  // B3: a routine with a work line — its crate (placeCronWorkitem) holds the LINE job, whose id is not the routine's
  cronItems.set('run-1', { agentId: 'agent', workitemId: 'w1', dockId: null, lineId: 'line-1', job: { id: 'job-line-1' } });
  await wrapper(Object.assign({}, fire, { runId: 'run-1', tokens: 100000 }));
  // advanceChain runs the line's hops after the entry settles, outside its scope (fireJob's .then): lineHopRun re-enters it
  await lineHopRun({ trigger: 'schedule', streamId: 'cron-run-1', runId: 'hop-1', tokens: 1350000 });
  await lineHopRun({ trigger: 'schedule', streamId: 'cron-run-1', runId: 'hop-2', tokens: 1350000 });
  await lineHopRun({ trigger: 'manual', streamId: 'manual-1', runId: 'hop-x', tokens: 5 });   // a Run Now hop: a person's
  A.eq(receipts.records().map(r => [r.runId, r.origin || '-', r.ref || '-', r.start || '-']),
    [['run-1', 'routine', 'routine-7', 'run-1'], ['hop-1', 'routine', 'routine-7', 'run-1'], ['hop-2', 'routine', 'routine-7', 'run-1'], ['hop-x', '-', '-', '-']],
    'B3: the entry and every hop of a routine\'s line are stamped with the ROUTINE\'s id and the fire\'s start (never the line job\'s id); a Run Now hop is a person\'s');
  A.eq(tokensPerStart(receipts.records(), { origin: 'routine', ref: 'routine-7' }), { tokens: 2800000, starts: 1 }, 'B3: tokens per fire counts the whole line: a 100k entry + 2 x 1.35M hops');
  A.ok(!!(cronItems.get('run-1').unattended && cronItems.get('run-1').unattended.ref === 'routine-7'), 'the fire records its start on its crate (what lineHopRun and a SEND TO of its job read)');

  // B2: the fire a person asked for (the driver's personAsked) runs as that person's run
  cronItems.set('run-2', { agentId: 'agent', workitemId: 'w2', dockId: null, lineId: 'line-1', job: { id: 'job-line-2' } });
  cronItems.set('run-3', { agentId: 'agent', workitemId: 'w3', dockId: null, lineId: null, job: null });
  const before = receipts.records().length;
  await wrapper(Object.assign({}, fire, { runId: 'run-2', tokens: 70000, personAsked: true }));
  await lineHopRun({ trigger: 'schedule', streamId: 'cron-run-2', runId: 'hop-3', tokens: 30000 });
  // even reached from inside an unattended start (a tick never runs in one: this is the guard), a person's fire stays theirs
  await asUnattended('loop', 'loop-1', () => wrapper(Object.assign({}, fire, { runId: 'run-3', tokens: 10, personAsked: true })), 'outer-1');
  A.eq(receipts.records().slice(before).map(r => [r.runId, r.origin || '-']), [['run-2', '-'], ['hop-3', '-'], ['run-3', '-']],
    'B2: a fire a person asked for — its entry and its line\'s hops — is never stamped unattended (the rail and tokens per fire leave it out)');
  A.eq(cronItems.get('run-2').unattended, undefined, 'B2: its crate records no unattended start, so a SEND TO of its job is a person\'s too');
  A.eq(seen.filter(o => o && Object.prototype.hasOwnProperty.call(o, 'personAsked')).length, 0, 'the host run never sees the driver\'s personAsked flag');
  A.eq(unattendedLive.size, 0, 'every start these fires opened is closed again');
}

// ---- B2: the person's fire through the REAL cron-store and cron-driver (a 92% reading holds every unattended fire here) ----
function personsFire() {
  const cron = require('../sidecar/cron.js');
  const cronStore = require('../sidecar/cron-store.js');
  const { makeCronDriver } = require('../sidecar/cron-driver.js');
  const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);
  const iso = ms => new Date(ms).toISOString();
  const HOLD = { ok: false, binding: 'window-reserve', say: 'held: the 5-hour window is at 92%' };
  // one tick of a FRESH driver (no lease from an earlier run hides an occurrence) over `jobs` at `at`
  const tickAt = (jobs, at) => {
    const s = { jobs, runs: [], admits: [] };
    let n = 0;
    const d = makeCronDriver({
      getJobs: () => s.jobs, setJobs: (j) => { s.jobs = j; },
      runOnce: (o) => { s.runs.push(o); return new Promise(() => {}); },   // in flight for the rest of the test
      emit: () => {}, newId: () => 'fire-' + at + '-' + (++n), newAbort: () => new AbortController(), now: () => at,
      getKey: () => 'sk', defaultModel: 'm', maxRunMs: 8 * MIN,
      admitUnattended: (job) => { s.admits.push(job.id); return HOLD; }
    });
    s.fired = d.applyTick(at).fired;
    return s;
  };
  const jobOf = (jobs, id) => cronStore.getJob(jobs, id) || {};
  const hourly = cronStore.makeJob({ id: 'hourly', prompt: 'tidy the inbox', agentId: 'agent', schedule: cron.parseSchedule('every 1h', T0) }, { id: 'hourly', now: T0 });

  const asked = cronStore.triggerJob([hourly], 'hourly', { now: T0 + 10 * MIN, personAsked: true });
  A.eq([jobOf(asked, 'hourly').nextRunAt, jobOf(asked, 'hourly').personAskedAt], [iso(T0 + 10 * MIN), iso(T0 + 10 * MIN)], 'B2: run_now in a person\'s run makes the routine due now and marks that occurrence theirs');
  const a = tickAt(asked, T0 + 10 * MIN);
  A.eq([a.fired, a.admits, a.runs.length ? a.runs[0].personAsked : 'no run'], [1, [], true], 'B2: at 92% that fire goes on the next tick — the hold is never asked, and the run is told it is a person\'s');
  A.eq(jobOf(a.jobs, 'hourly').personAskedAt, undefined, 'B2: the mark is taken in the same write that advances the job');
  const b = tickAt(a.jobs, T0 + 70 * MIN);
  A.eq([b.fired, b.admits], [0, ['hourly']], 'B2: the mark is used once — the routine\'s own next occurrence is asked, and held at 92%');
  const c = tickAt(cronStore.triggerJob(b.jobs, 'hourly', { now: T0 + 80 * MIN }), T0 + 80 * MIN);
  A.eq([c.fired, c.admits], [0, ['hourly']], 'B2: a run_now made inside an unattended start is that start\'s work: asked, and held');
  const moved = cronStore.triggerJob(cronStore.triggerJob(c.jobs, 'hourly', { now: T0 + 90 * MIN, personAsked: true }), 'hourly', { now: T0 + 91 * MIN });
  A.eq(jobOf(moved, 'hourly').personAskedAt, iso(T0 + 91 * MIN), 'a person\'s fire not taken yet stays theirs when a later trigger re-stamps it');
  const rewound = c.jobs.map(j => (j && j.id === 'hourly') ? Object.assign({}, j, { personAskedAt: iso(T0 + 100 * MIN), nextRunAt: iso(T0 + 102 * MIN) }) : j);
  const e = tickAt(rewound, T0 + 102 * MIN);
  A.eq([e.fired, e.admits, jobOf(e.jobs, 'hourly').personAskedAt], [0, ['hourly'], undefined], 'B2: a mark its occurrence no longer matches (a retry rewound it) admits nothing, and is dropped');
  // a ONE-SHOT held at 92%: not in flight, so its claim is released and it is rechecked a minute on — and a person's run_now fires it
  const once = cronStore.makeJob({ id: 'once', prompt: 'write the note', agentId: 'agent', schedule: cron.parseSchedule('in 5m', T0) }, { id: 'once', now: T0 });
  const f = tickAt([once], T0 + 5 * MIN);
  A.eq([f.fired, f.admits, jobOf(f.jobs, 'once').fireClaim, jobOf(f.jobs, 'once').nextRunAt], [0, ['once'], null, iso(T0 + 5 * MIN + 60000)],
    'a held one-shot is released and rechecked in a minute (it sat claimed for 8 minutes, so a run_now could not fire it)');
  const g = tickAt(cronStore.triggerJob(f.jobs, 'once', { now: T0 + 5 * MIN + 10000, personAsked: true }), T0 + 5 * MIN + 10000);
  A.eq([g.fired, g.admits, g.runs.length ? g.runs[0].personAsked : 'no run'], [1, [], true], 'B2: a person\'s run_now on a held one-shot fires it on the next tick');
}

// ---- B4: a line trigger's fire through the REAL trigger runner ----
async function triggerHold() {
  const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
  const Tg = require('../sidecar/routing/triggers.js');
  let disk = { triggers: [] }, n = 0, words = 'unattended work is held: the codex 5-hour window is at 92%';
  const hub = [], asked = [], ran = [];
  let inScope = null;
  const R = makeTriggerRunner({
    load: () => JSON.parse(JSON.stringify(disk)), save: v => { disk = JSON.parse(JSON.stringify(v)); },
    makeHub: hooks => ({ onInbound(msg) {
      hub.push({ text: msg.text, scope: inScope });
      hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' });
      hooks.onResolved({ chatId: msg.chatId, agentId: 'agent-a', isTask: true, lineId: 'L1', dockId: 'b1' });
      return Promise.resolve();
    }, close() {} }),
    plan: () => ({ lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } }),
    dayCap: () => ({ cap: null, spent: 0 }), runsFor: () => [], emit: () => {},
    unattendedHold: (t) => { asked.push(t.lineId); return words; },
    asUnattended: (t, streamId, fn) => { ran.push(t.id); inScope = { trigger: t.id, start: streamId }; try { return fn(); } finally { inScope = null; } },
    now: () => NOW, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {}
  });
  const made = R.create({ kind: 'webhook', lineId: 'L1', name: 'hook', maxPerHour: 100 }, { secretHash: Tg.hashSecret('k') });
  const id = made && made.trigger && made.trigger.id;
  A.eq(R.preflight(R.get(id)), words, 'B4: a trigger\'s fire is unattended work: its preflight asks the hold and says it in the hold\'s words');
  const no = R.enqueue(id, { text: 'a webhook call while the window is nearly used' });
  A.ok(!no.ok && no.error === words, 'B4: the webhook call is refused with those words (409, never queued to burst after the reset): ' + JSON.stringify(no));
  A.eq([R.view(id).lastError, R.view(id).blockedBy], [words, words], 'B4: the trigger\'s lastError and blockedBy say why');
  A.ok(!R.canAccept(id).ok, 'B4: a folder poll asks canAccept first, so a dropped file waits in its folder');
  A.eq(hub.length, 0, 'B4: the hub (and so the model) is never reached');
  A.ok(asked.length > 0 && asked.every(l => l === 'L1'), 'B4: asked on the trigger\'s own line');
  words = null;
  const go = R.enqueue(id, { text: 'the window has reset' });
  A.ok(go.ok, 'B4: once there is room the same trigger fires');
  await settle(30);
  A.eq(hub.length, 1, 'B4: exactly that one job reached the hub');
  A.ok(!!(hub[0] && hub[0].scope && hub[0].scope.trigger === id && /\S/.test(hub[0].scope.start || '')), 'B4: it runs as the trigger\'s own unattended start (the hub\'s first slice ran inside it, its stream the start): ' + JSON.stringify(hub[0]));
}

// ---- B4: a SEND TO of unattended work through the REAL hand-off runner, on a real compiled station (A sends to B) ----
async function handoffHold() {
  const P = require('../frontend/app/pipeline.js');
  const WM = require('../frontend/app/worldmodel.js');
  const LE = require('../frontend/app/lineedit.js');
  const LineJobs = require('../sidecar/routing/linejobs.js');
  const { makeHandoffRunner } = require('../sidecar/routing/handoff-runner.js');
  const { crewedDocksOnLine } = require('../sidecar/routing/trigger-runner.js');
  const d = WM.starterDoc();
  for (const rid in d.rooms) for (const r of d.rooms[rid].rects) { r.x2 = 44; r.y2 = 20; }
  const st = WM.create(d);
  const L = [];
  for (let i = 0; i < 2; i++) {
    const r = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 + i * 6 });
    if (!r.ok) throw new Error('placeBlueprint ' + JSON.stringify(r));
    const of = t => r.ids.filter(pid => st.propById(pid).t === t);
    L.push({ intake: of('intake')[0], bays: of('bay'), outbox: of('outbox')[0] });
    st.setPropLabel(of('intake')[0], String.fromCharCode(65 + i));
  }
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  st.setSendTo(L[0].outbox, L[1].intake);
  const plan = P.compileRoutingPlan(st.projectGeometry());
  const LA = plan.lineOfProp[L[0].intake], LB = plan.lineOfProp[L[1].intake];
  let jobs = { jobs: [] }, n = 0, words = 'unattended work is held: the codex 5-hour window is at 92%', inScope = null;
  const put = x => { if (x.job) jobs = x.state; return x.job; };
  const J = { get: id => LineJobs.get(jobs, id), byStream: s => LineJobs.byStream(jobs, s), start: r => put(LineJobs.start(jobs, r)), finish: (id, r) => put(LineJobs.finish(jobs, id, r)),
    link: (id, to) => put(LineJobs.link(jobs, id, to)), latest: line => LineJobs.latest(jobs, line), again: (id, at) => put(LineJobs.again(jobs, id, at)) };
  const hub = [], asked = [];
  const START = { origin: 'routine', ref: 'routine-7', start: 'run-1' };
  const R = makeHandoffRunner({
    makeHub: hooks => ({ onInbound(msg) {
      const line = hooks.lineId();
      hub.push({ line, scope: inScope });
      const dock = crewedDocksOnLine(plan, line).sort(P.propIdCmp)[0];
      hooks.onRouted(dock ? { agentId: plan.agentOfDock[dock], dockId: dock } : null);
      hooks.onResolved({ chatId: msg.chatId, agentId: plan.agentOfDock[dock], isTask: true, lineId: line, dockId: dock });
      return Promise.resolve();
    } }),
    plan: () => plan, jobs: J, emit: () => {}, runsFor: () => [], now: () => 1000, newId: () => 'id' + (++n) + 'abcdef0123456789', warn: () => {},
    startOf: rec => (/^cron-/.test(String(rec.streamId || '')) ? START : null),
    unattendedHold: (start, toLine) => { asked.push([start.origin, toLine]); return words; },
    asUnattended: (start, fn) => { inScope = start; try { return fn(); } finally { inScope = null; } }
  });
  const ship = (jobId, streamId) => {
    J.start({ id: jobId, line: LA, name: 'A', text: 'Find three facts about Mars.', streamId, at: 1000 });
    return R.onShipped({ lineId: LA, jobId, agentId: 'ag_' + L[0].bays[1], dockId: L[0].bays[1], text: 'Mars has two moons.', originalText: 'Find three facts about Mars.', streamId, since: 1000 });
  };
  const held = ship('job-aaaa1111', 'cron-run-1');   // a job a routine's fire started (its stream is the fire's)
  A.ok(!held.ok && held.error === words, 'B4: a SEND TO of a routine fire\'s job, at 92%: refused with the hold\'s words (never queued to burst after the reset) — ' + JSON.stringify(held));
  const bRec = jobs.jobs.find(j => j.line === LB);
  A.ok(!!(bRec && bRec.status === 'failed' && String(bRec.error || '').indexOf(words) >= 0), 'B4: ...said on LINE B\'s own job record: ' + JSON.stringify(bRec && { status: bRec.status, error: bRec.error }));
  A.eq(asked, [['routine', LB]], 'B4: asked once, as the fire\'s origin, on the TARGET line');
  A.eq(hub.length, 0, 'B4: LINE B (and so the model) was never reached');
  words = null;
  const go = ship('job-bbbb2222', 'cron-run-1');
  A.ok(go.ok, 'B4: with room, the hand-off goes');
  await settle(30);
  A.eq(hub.map(h => [h.line, h.scope && h.scope.start]), [[LB, 'run-1']], 'B4: LINE B\'s job runs inside the start that shipped it (its receipts count with that fire)');
  const mine = ship('job-cccc3333', 'sample-cccc3333');   // a person's job (SEND A JOB, a message)
  await settle(30);
  A.ok(mine.ok && asked.length === 3 && hub.length === 2 && hub[1].scope === null, 'B4: a person\'s job is never asked and runs as theirs, outside any unattended start: ' + JSON.stringify({ mine, asked: asked.length, hub }));
}

// ---- B4: who started a shipped job (unattendedStartOf), and the hold for a line's own start (holdLineStart) ----
async function lineStarts() {
  const { cronItems, asUnattended, unattendedNow } = host;
  const startOf = build('unattendedStartOf', { unattendedNow, cronItems });
  if (typeof startOf !== 'function' || typeof unattendedNow !== 'function') A.ok(false, 'B4: unattendedStartOf (who started a shipped job) is in the sidecar');
  else {
    cronItems.set('run-9', { job: null, unattended: { origin: 'routine', ref: 'routine-9', start: 'run-9' } });
    cronItems.set('run-10', { job: null });   // a fire a person asked for: no start recorded
    A.eq(startOf({ streamId: 'cron-run-9' }), { origin: 'routine', ref: 'routine-9', start: 'run-9' }, 'B4: a job a scheduled fire shipped belongs to that fire (read off its crate)');
    A.eq(startOf({ streamId: 'cron-run-10' }), null, 'B4: a fire a person asked for recorded no start: its job is theirs');
    A.eq(startOf({ streamId: 'sample-1' }), null, 'B4: a sample job belongs to no unattended start');
    A.eq(await asUnattended('trigger', 'trg-1', () => startOf({ streamId: 'trigger-abc' }), 'trigger-abc'), { origin: 'trigger', ref: 'trg-1', start: 'trigger-abc' },
      'B4: a job shipped inside a trigger\'s fire belongs to that fire (the live scope first)');
  }
  const lineAsked = [];
  let room = new Set();
  const holdLineStart = build('holdLineStart', {
    UnattendedAdmission: UA, admit: { getPlan: () => ({ lines: [] }) },
    Pipeline: { hasDockLayer: () => true, dockLayer: () => ({ agentOfDock: { d1: 'ag1', d2: 'ag2', d3: 'ag3' } }) },
    crewedDocksOnLine: (plan, lineId) => (lineId === 'L1' ? ['d1', 'd3'] : lineId === 'L2' ? ['d1', 'd2'] : []),
    unattendedHold: (origin, ctx) => { lineAsked.push([origin, ctx.provider]); return room.has(ctx.provider) ? null : { say: 'held on ' + ctx.provider }; },
    sampleRunConfigFor: (agentId) => ({ provider: ({ ag1: 'codex', ag2: 'openrouter', ag3: 'codex' })[agentId] }),
    failNote: () => {}
  });
  if (typeof holdLineStart !== 'function') { A.ok(false, 'B4: holdLineStart (the hold for a line\'s own start) is in the sidecar'); return; }
  A.eq((holdLineStart('trigger', 'L1') || {}).say, 'held on codex', 'B4: a line whose every entry is held is held, in the hold\'s words');
  room = new Set(['openrouter']);
  A.eq(holdLineStart('trigger', 'L2'), null, 'B4: one entry the line may pick has room: admitted (the dock it picks is not known before it picks)');
  A.eq(lineAsked, [['trigger', 'codex'], ['trigger', 'codex'], ['trigger', 'codex'], ['trigger', 'openrouter']], 'B4: each crewed entry is asked on its own agent\'s provider');
  A.eq(holdLineStart(null, 'L1'), null, 'B4: a person\'s start is never asked');
  A.eq(holdLineStart('routine', 'L-none'), null, 'B4: a line with no crewed entry: nothing here holds it (the runner\'s own preflight says so)');
}

// ---- a fire that calls no model spends nothing: never held (holdRoutineFire) ----
function zeroSpend() {
  const asked = [];
  const HELD = { ok: false, binding: 'window-reserve', say: 'held words', ledger: {} };
  const holdRoutineFire = build('holdRoutineFire', { unattendedHold: (origin, ctx) => { asked.push([origin, ctx && ctx.provider]); return HELD; },
    unattendedHeldRows: new Map(), ledgerUnattendedHold: () => {}, runsAsCommand: require('../sidecar/routine-identity.js').runsAsCommand });
  if (typeof holdRoutineFire !== 'function') { A.ok(false, 'holdRoutineFire is in the sidecar'); return; }
  A.eq(holdRoutineFire({ id: 's1', agentId: 'agent', noAgent: true, script: 'check.js' }, { provider: 'codex', prompt: 'x' }), null, 'a script-only routine (noAgent) calls no model: never held');
  A.eq(holdRoutineFire({ id: 's2', agentId: 'agent' }, { provider: 'codex', prompt: '/usage' }), null, 'a slash-command routine runs the command, no model: never held');
  A.eq(holdRoutineFire({ id: 's3', agentId: 'agent', script: 'pre.js' }, { provider: 'codex', prompt: '/usage' }), HELD, '...but with a pre-check script it is a model turn: held');
  A.eq(holdRoutineFire({ id: 's4', agentId: 'agent', noAgent: true, runsLine: true }, { provider: 'codex', prompt: 'x' }), HELD, 'a routine whose work line runs after it still spends: held');
  A.eq(holdRoutineFire({ id: 's5', agentId: 'agent', meta: { workshop: true } }, { provider: 'codex', prompt: 'build' }), HELD, 'the away-workshop shift: held as an away build');
  A.eq(asked, [['routine', 'codex'], ['routine', 'codex'], ['workshop', 'codex']], 'only the fires that spend are asked');
}

(async () => {
  const run = async (name, fn) => { try { await fn(); } catch (e) { A.ok(false, name + ' threw: ' + ((e && e.stack) || e)); } };
  await run('fireScope', fireScope);
  await run('personsFire', personsFire);
  await run('triggerHold', triggerHold);
  await run('handoffHold', handoffHold);
  await run('lineStarts', lineStarts);
  await run('zeroSpend', zeroSpend);
  A.report('unattended-hold.test');
})();
