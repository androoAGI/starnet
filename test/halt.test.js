/* node test/halt.test.js — the E-STOP kill logic (sidecar/halt.js). Locks: killAll aborts EVERY browser run
   AND every messaging-hub run, gives each hub run its endReason BEFORE aborting (so no stale partial reply ships
   after the kill), returns the count, and never throws on null maps or a throwing abort (an E-STOP must not
   fail). A withdrawn run has ONE ending and the first one written stands. The HTTP route /api/halt is verified
   separately by a live sidecar smoke. */
'use strict';
const A = require('./_assert.js');
const { killAll, endOf, markEnd } = require('../sidecar/halt.js');

function fakeAc() { let aborted = false; return { abort() { aborted = true; }, get aborted() { return aborted; } }; }

/* ---- browser runs only ---- */
{
  const a = fakeAc(), b = fakeAc();
  const n = killAll(new Map([['r1', a], ['r2', b]]), null);
  A.eq(n, 2, 'aborts both browser runs and counts them');
  A.ok(a.aborted && b.aborted, 'both browser controllers aborted');
}

/* ---- browser + hub runs: each hub run has its ending BEFORE the abort ---- */
{
  const a = fakeAc();
  const seen = [];
  const h1 = { abort: { abort() { seen.push(endOf(h1)); } } };
  const h2 = { abort: fakeAc() };
  const n = killAll(new Map([['r1', a]]), new Map([['c1', h1], ['c2', h2]]));
  A.eq(n, 3, 'counts browser + both hub runs');
  A.ok(a.aborted, 'browser run aborted');
  A.eq(seen, ['halted'], 'the run\'s ending is written BEFORE its abort: no stale partial delivered after HALT');
  A.ok(h2.abort.aborted, 'both hub runs aborted');
  A.eq([endOf(h1), endOf(h2)], ['halted', 'halted'], 'both hub runs ended halted');
}

/* ---- MULTIPLE hub maps (Telegram + Discord) are all killed in one call ---- */
{
  const a = fakeAc();
  const tg = { abort: fakeAc() };
  const dc = { abort: fakeAc() };
  const n = killAll(new Map([['r1', a]]), new Map([['c1', tg]]), new Map([['c2', dc]]));
  A.eq(n, 3, 'counts browser + telegram + discord hub runs');
  A.ok(a.aborted, 'browser run aborted');
  A.ok(tg.abort.aborted && endOf(tg) === 'halted', 'telegram hub run aborted + halted');
  A.ok(dc.abort.aborted && endOf(dc) === 'halted', 'discord hub run aborted + halted');
  A.eq(killAll(null, null, null), 0, 'all-null hub maps -> 0, no throw');
}

/* ---- the E-STOP must be unbreakable: null maps, a throwing abort, a null rec ---- */
{
  A.eq(killAll(null, null), 0, 'null maps -> 0, no throw');
  const boom = { abort() { throw new Error('boom'); } };
  let n;
  A.notThrows(() => { n = killAll(new Map([['r1', boom], ['r2', fakeAc()]]), null); }, 'a throwing abort never propagates out of the E-STOP');
  A.eq(n, 2, 'still counts a run whose abort threw');
  A.notThrows(() => killAll(new Map(), new Map([['c', null]])), 'a null hub rec is tolerated');
}

/* ---- THE STATION'S OWN FAULT is not the Commander's E-STOP (wave 2 repair, conveyor-backend-08): the process-fault containment
   ends the hub runs it is about to kill 'faulted', so the hub's notice and the step test name the fault. ---- */
{
  const { markFaulted } = require('../sidecar/halt.js');
  const a = fakeAc();
  const h1 = { abort: fakeAc() };
  const h2 = { abort: fakeAc() };
  const browser = new Map([['r1', a]]);
  A.eq(markFaulted(new Map([['c1', h1]]), null, new Map([['c2', h2], ['c3', null]])), 2, 'marks every hub run of every map (null maps and recs tolerated)');
  A.ok(endOf(h1) === 'faulted' && endOf(h2) === 'faulted', 'each hub run carries the fault');
  A.ok(!h1.abort.aborted, 'marking alone stops nothing: the kill is still killAll');
  A.eq(killAll(browser, new Map([['c1', h1]])), 2, 'then the ordinary kill');
  A.ok(h1.abort.aborted && endOf(h1) === 'faulted', 'a fault-killed hub run is aborted, and stays faulted: killAll never renames it an E-STOP');
  const e = { abort: fakeAc() };
  killAll(null, new Map([['c', e]]));
  A.eq(endOf(e), 'halted', 'a plain E-STOP never marks a run faulted');
  A.notThrows(() => markFaulted(), 'no maps -> no throw');
}

/* ---- ONE ENDING, AND THE FIRST ONE STANDS (channel-delivery-ledger S5). Four flags used to say how a run was withdrawn:
   superseded, supersededBy, halted and faulted, with three writers, and every reader had to know which combinations meant
   what. A withdrawn run now carries one endReason. Whatever wrote it first is what happened to the run, and what its chat is
   told: a later kill still aborts it (an E-STOP stops everything), but it does not rewrite why the run ended. ---- */
{
  const { markFaulted } = require('../sidecar/halt.js');
  A.eq(endOf({ abort: fakeAc() }), null, 'a run nothing withdrew has no ending');
  A.eq(endOf({ endReason: null }), null, 'a fresh record has none either');
  A.eq(endOf(null), null, 'a null record reads as no ending');
  for (const first of ['superseded', 'stopped', 'halted', 'faulted']) {
    const rec = { abort: fakeAc() };
    A.ok(markEnd(rec, first) === true, first + ': the first ending is written');
    A.ok(markEnd(rec, 'stopped') === false && endOf(rec) === first, first + ': a second ending changes nothing');
    A.eq(markFaulted(new Map([['c', rec]])), 0, first + ': markFaulted marks no run that already ended');
    A.eq(killAll(null, new Map([['c', rec]])), 1, first + ': E-STOP still counts it');
    A.ok(rec.abort.aborted, first + ': and still aborts it, whatever ended it');
    A.eq(endOf(rec), first, first + ': neither renames how it ended');
  }
  A.ok(markEnd(null, 'halted') === false, 'markEnd tolerates a null record');
  const legacy = { abort: fakeAc() };
  markFaulted(new Map([['c', legacy]]));
  killAll(null, new Map([['c', legacy]]));
  A.eq(Object.keys(legacy).sort(), ['abort', 'endReason'], 'the kill writes one field: the four old flags are gone');
}

A.report('halt');
