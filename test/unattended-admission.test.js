/* node test/unattended-admission.test.js — the futile-beat skip's resolver (sidecar/unattended-admission.js) and the
   driver seam that carries its hold (cost fix W1.6). Pure: a fake clock and fake deps, no sidecar.

   The rule: a build beat that ended 'duplicate-backlog' against a BUILT, undecided item is remembered with the
   fingerprint of what it read; the next beats are held before the leash is spent ('awaiting-verdict', naming the
   build) only while that fingerprint is unchanged and the build is still undecided. Any change re-admits at once.
   The real sidecar proof (0 provider calls, leash unchanged, one ledger row, re-admitted by a message and a verdict,
   across a restart) is test/nightshift-futile-beat.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const UA = require('../sidecar/unattended-admission.js');
const { makeNightshiftDriver } = require('../sidecar/nightshift-driver.js');
const ns = require('../sidecar/nightshift.js');

// ---- fingerprint: one stable digest of the parts, key order never matters, any change moves it ----
(function fingerprint() {
  const parts = { work: [['undecided', 'r2', 'b2', 'Continue: X']], backlog: [['b2', 'continue: x', 'r2', '']], activity: [['u1', 100]], context: { goal: null, known: ['goals'], beliefs: { goals: ['ship'] }, threads: [] }, focus: ['', '', ''], project: null, posture: ['leash', 'sandbox'], engine: ['openrouter', 'm'] };
  const reordered = { engine: ['openrouter', 'm'], posture: ['leash', 'sandbox'], project: null, focus: ['', '', ''], context: { threads: [], beliefs: { goals: ['ship'] }, known: ['goals'], goal: null }, activity: [['u1', 100]], backlog: [['b2', 'continue: x', 'r2', '']], work: [['undecided', 'r2', 'b2', 'Continue: X']] };
  const fp = UA.fingerprint(parts);
  A.ok(/^[0-9a-f]{64}$/.test(fp), 'a sha256 hex digest');
  A.eq(UA.fingerprint(reordered), fp, 'the same parts in another key order hash alike');
  A.eq(UA.fingerprint(JSON.parse(JSON.stringify(parts))), fp, 'a copy hashes alike');
  const moved = (mut) => { const p = JSON.parse(JSON.stringify(parts)); mut(p); return UA.fingerprint(p) !== fp; };
  A.ok(moved(p => p.activity.unshift(['u2', 200])), 'a new owner run (a new message) moves it');
  A.ok(moved(p => { p.work = []; p.backlog = []; }), 'a verdict (the build leaves the backlog) moves it');
  A.ok(moved(p => p.backlog.push(['b3', 'new task', '', ''])), 'a new task moves it');
  A.ok(moved(p => p.context.threads.push(['t1', 5])), 'a new open thread moves it');
  A.ok(moved(p => { p.project = ['/p', true, 'abc']; }), 'a project focus with a new HEAD moves it');
  A.ok(moved(p => { p.focus[2] = '/steered'; }), 'a steer moves it');
  A.ok(moved(p => { p.posture[1] = 'observe'; }), 'a dial change moves it');
  A.ok(moved(p => { p.engine[1] = 'another/model'; }), 'a model change moves it');
  A.ok(moved(p => { p.context.beliefs.goals = ['ship v2']; }), 'a dossier change moves it');
  A.eq(UA.canonical({ b: 1, a: undefined, c: [1, { z: 2, y: 1 }] }), '{"b":1,"c":[1,{"y":1,"z":2}]}', 'canonical sorts keys at every depth and drops undefined');
})();

// ---- settle: only the dead end against an undecided build is remembered ----
(function settle() {
  const seen = { fp: 'f1' };
  A.eq(UA.settle(seen, { delivered: false, reason: 'duplicate-backlog', waitingOn: { runId: 'r2', backlogId: 'b2' } }, 7), { fp: 'f1', runId: 'r2', backlogId: 'b2', at: 7 }, 'the dead end on an undecided build is remembered with what the beat read');
  A.eq(UA.settle(seen, { delivered: false, reason: 'duplicate-backlog' }, 7), null, 'a title refused for another cause (queued, discarded) names no build to wait on: nothing remembered');
  A.eq(UA.settle(seen, { delivered: true, reason: 'built' }, 7), null, 'a delivery forgets it');
  A.eq(UA.settle(seen, { delivered: false, reason: 'no-candidates' }, 7), null, 'another stand-down forgets it');
  A.eq(UA.settle(seen, null, 7), null, 'a beat that threw forgets it');
  A.eq(UA.settle({ fp: null }, { reason: 'duplicate-backlog', waitingOn: { runId: 'r2' } }, 7), null, 'an unproven reading (no fingerprint) is never remembered');
})();

// ---- decide: hold only while nothing changed and the build is still undecided ----
(function decide() {
  const stuck = { fp: 'f1', runId: 'r2', backlogId: 'b2', at: 1 };
  const waiting = { title: 'Continue: X', runId: 'r2' };
  A.eq(UA.decide({ stuck: null, fp: 'f1', waiting }), { admit: true }, 'nothing remembered: admit');
  A.eq(UA.decide({ stuck, fp: 'f1', waiting }), { admit: false, binding: 'awaiting-verdict', why: { title: 'Continue: X', runId: 'r2' } }, 'unchanged and still undecided: held, naming the build');
  A.eq(UA.decide({ stuck, fp: 'f2', waiting }).admit, true, 'anything the beat reads changed: admitted at once');
  A.eq(UA.decide({ stuck, fp: null, waiting }).admit, true, 'an unproven reading never holds');
  A.eq(UA.decide({ stuck, fp: 'f1', waiting: null }).admit, true, 'the build was decided (no longer in the backlog): nothing is awaited');
  A.eq(UA.decide({ stuck, fp: 'f1', waiting: { title: 'Y', runId: 'r9' } }).admit, true, 'another build in its place is not the one awaited');
  A.eq(UA.AWAITING_VERDICT, 'awaiting-verdict', 'the binding name');
})();

// ---- the driver carries the hold: before the spend, one edge-triggered row naming the build, status sees it ----
(function driverSeam() {
  const T0 = 1700000000000, MIN = 60000;
  let state = ns.fresh(T0), beats = 0, writes = 0, hold = { ok: false, reason: 'awaiting-verdict', why: { title: 'Continue: X', runId: 'r2', nested: { no: 1 } } };
  const ledger = [];
  const d = makeNightshiftDriver({
    getState: () => state, setState: (s) => { writes++; state = s; },
    getPosture: () => ({ actsUnattended: true, leashPerDay: 3 }),
    lastActivity: () => 0, precheck: () => hold,
    beat: () => { beats++; return Promise.resolve({ delivered: false, reason: 'duplicate-backlog' }); },
    now: () => T0, ledger: (e) => ledger.push(e), awayThresholdMs: 15 * MIN, beatIntervalMs: 45 * MIN
  });
  for (let i = 0; i < 30; i++) A.eq(d.applyTick(T0 + i * MIN).binding, 'awaiting-verdict', i ? undefined : 'a held tick binds awaiting-verdict');
  A.eq(beats, 0, 'no beat ran (no model call)');
  A.eq(state.beatsUsedToday || 0, 0, 'no leash unit was spent');
  const rows = ledger.filter(e => e.kind === 'decline');
  A.eq(rows.length, 1, '30 held ticks write ONE decline row');
  A.ok(rows[0].preSpend === true && rows[0].why && rows[0].why.title === 'Continue: X' && rows[0].why.runId === 'r2' && !('nested' in rows[0].why), 'the row is pre-spend and names the build (primitives only): ' + JSON.stringify(rows[0]));
  const st = d.statusDecision(T0 + 31 * MIN);
  A.ok(st.fire === false && st.binding === 'awaiting-verdict' && st.why && st.why.runId === 'r2', 'status reads the same hold and names the build');
  hold = { ok: false, reason: 'awaiting-verdict', why: { title: 'Continue: Y', runId: 'r3' } };
  d.applyTick(T0 + 32 * MIN);
  A.eq(ledger.filter(e => e.kind === 'decline').length, 2, 'a hold on ANOTHER build is a new edge: one more row');
  hold = { ok: true };
  A.eq(d.applyTick(T0 + 33 * MIN).fired, true, 'the moment the precheck admits, the beat fires');
  A.eq(beats, 1, 'and makes its call');
  A.eq(state.beatsUsedToday, 1, 'spending its leash unit at accept time, as before');
  A.ok(writes >= 1, 'the spend was persisted');
  const plain = makeNightshiftDriver({ getState: () => ns.fresh(T0), setState() {}, getPosture: () => ({ actsUnattended: true, leashPerDay: 3 }), lastActivity: () => 0,
    precheck: () => ({ ok: false, reason: 'readiness' }), beat: () => Promise.resolve({}), ledger: (e) => ledger.push(e), awayThresholdMs: 15 * MIN, beatIntervalMs: 45 * MIN });
  ledger.length = 0;
  plain.applyTick(T0);
  A.ok(ledger[0] && ledger[0].binding === 'readiness' && !('why' in ledger[0]), 'a stand-down without a why writes the row it always wrote');
  A.ok(!('why' in plain.statusDecision(T0)), 'and status carries no why');
})();

A.report('unattended-admission.test');
