'use strict';
/* test/unknown-spend-state.test.js — EVERY UNKNOWN ITEM IS COUNTED AT ITS BOUND OR NAMES A ONE-CLICK EXIT (spend-governor S3;
   customer reports d688ea20, email E04: "Spend history unavailable" refusals that survived restart and reinstall).

   Unknown spend used to be GLOBAL: one torn ledger line, or a run interrupted three days earlier, made a chosen limit refuse
   every paid run until someone settled it, and RESUME refused too. The family is "an open receipt decides admission", so
   this pins the class, not one path: for every kind of open item (a damaged line whose charge is readable or not, an
   interrupted run with or without a per-run limit, an unpriced skill evaluation) and every pool (agent, day, global; chosen
   or the shipped soft rail), through the real ledger, budget, governor and loop:
     - each item is counted at its bound in exactly the pools that can contain it, and a counted item is never $0;
     - a cap stop the bound causes is an ordinary cap stop, and RESUME works over it;
     - only an item with no bound refuses, only a chosen pool that contains it, and the refusal names its one-click exit
       (COUNT AS $X, enter the charge, or set that limit to 0), as do the write and read causes;
     - every item can be settled in one click at the figure its row names, and the booking says which figure it was.
   The real-sidecar half (a capped run proceeds over a torn line, RESUME 200, settle mode 'bound', bytes untouched, restart
   identity) is test/ledger-damaged-line.http.test.js. */
const assert = require('node:assert/strict');
const vm = require('node:vm'), crypto = require('node:crypto');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const { makeRunStore } = require('../sidecar/runstore.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { friendlyError } = require('../frontend/app/friendlyerror.js');
const { readSidecarSource } = require('./helpers/source.js');

const DAY = 86400000, NOW = 10 * DAY;
const clock = { now: () => NOW };
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
// a ledger as the host builds one (index.js makeLedger over ledgerIo): the rows read at boot and the receipts open at boot
function ledgerWith(rows, receipts, opts) {
  const io = { readAll: () => rows.map(r => Object.assign({}, r)), unsettled: () => receipts.map(r => Object.assign({}, r)), append() {}, beginRun() {}, finishRun() {} };
  return makeLedger(Object.assign({ io, clock, nextId: () => crypto.randomUUID() }, opts || {}));
}
const chosen = () => true;   // a limit the Commander chose is strict (index.js budgetScopeIsExplicit)
const prior = { runId: 'prior', agentId: 'agent', usd: 0.5, ts: NOW - 3600000 };
const tornLine = { runId: 'damaged-aaaaaaaaaaaaaaaaaaaaaaaa', agentId: 'nova', kind: 'damaged', lineHash: 'a'.repeat(64) };

// ---- probe P2: one damaged line under a chosen $25 day cap. Before: refused { unknown, cause 'damaged' }, resume null ----
{
  const L = ledgerWith([prior], [tornLine]);
  const B = makeBudget({ caps: { day: 25 }, ledger: L, clock, strictScope: chosen });
  assert.equal(B.check('r1', 'agent', 0, NOW, null), null, 'a damaged line never refuses a run by itself');
  const st = B.status(NOW);
  assert.deepEqual(st.unknown, { items: 1, unbounded: 0, countedUsd: 2 }, 'status names the unknown block: ' + JSON.stringify(st.unknown));
  assert.ok(near(st.day.usd, 2.5) && near(st.day.countedUsd, 2), 'the day pool reads what check counts, the line at its $2 bound: ' + JSON.stringify(st.day));
  assert.equal(B.resume('day'), 50, 'RESUME works over a counted item');
  assert.deepEqual([L.health().complete, L.unsettledRuns().length], [false, 1], 'the line stays listed: history is not exact until it is settled');
}
// ---- probe P2b: a run interrupted 3 days ago never blocks the DAY pool, with or without a recorded limit ----
for (const receipt of [{ runId: 'old-capped', agentId: 'agent', ts: NOW - 3 * DAY, runCapUsd: 0.5 }, { runId: 'old-open', agentId: 'agent', ts: NOW - 3 * DAY }]) {
  const B = makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior], [receipt]), clock, strictScope: chosen });
  assert.equal(B.check('r1', 'agent', 0, NOW, null), null, receipt.runId + ': an item outside the window never blocks that pool');
  assert.ok(near(B.status(NOW).day.usd, 0.5), receipt.runId + ': the day pool reads only what it can contain: ' + JSON.stringify(B.status(NOW).day));
  assert.equal(B.resume('day'), 50);
}

// ---- every kind of item has a bound or a one-click figure, and neither is ever $0 ----
{
  const rows = [{ runId: 'big', agentId: 'agent', usd: 3.75, ts: NOW - 5 * DAY }, { runId: 'plan', agentId: 'agent', usd: 9, unmetered: true, ts: NOW - DAY }, prior];
  const receipts = [
    { runId: 'damaged-r', agentId: 'nova', kind: 'damaged', lineHash: 'b'.repeat(64), recordedUsd: 0.7 },
    { runId: 'damaged-a', kind: 'damaged', lineHash: 'c'.repeat(64) },
    { runId: 'crashed-capped', agentId: 'agent', ts: NOW - 60000, runCapUsd: 0.75 },
    { runId: 'crashed-open', agentId: 'agent', ts: NOW - 60000 },
    { runId: 'skill-eval-3f2a9c1d-1-before-0123456789ab', agentId: 'agent', ts: NOW - 60000, runCapUsd: 0.08 }
  ];
  const items = ledgerWith(rows, receipts).unknownItems();
  const by = id => items.find(i => i.runId === id);
  assert.deepEqual(items.map(i => i.kind), ['damaged', 'damaged', 'interrupted', 'interrupted', 'evaluation']);
  assert.deepEqual(by('damaged-r').bound, { usd: 0.7, source: 'recorded' }, 'a damaged line counts at the charge it still records');
  assert.deepEqual(by('damaged-a').bound, { usd: 3.75, source: 'assumed' }, 'one whose charge cannot be read: the largest single charge the ledger records (a plan figure is no charge)');
  assert.deepEqual(by('crashed-capped').bound, { usd: 0.75, source: 'limit' }, 'an interrupted run counts at its recorded per-run limit');
  assert.deepEqual(by('skill-eval-3f2a9c1d-1-before-0123456789ab').bound, { usd: 0.08, source: 'limit' }, 'so does an unpriced evaluation');
  assert.equal(by('crashed-open').bound, null, 'an interrupted run with no limit has no bound');
  assert.deepEqual(by('crashed-open').countAs, { usd: 3.75, source: 'assumed' }, '...but still a one-click figure');
  assert.deepEqual([by('crashed-open').agentId, by('crashed-open').ts, 'agentId' in by('damaged-a'), 'ts' in by('damaged-a')], ['agent', NOW - 60000, false, false], 'only what the receipt says');
  for (const i of items) assert.ok(i.countAs && i.countAs.usd > 0 && (!i.bound || i.bound.usd > 0), 'a counted item is never $0 and every item has a one-click exit: ' + JSON.stringify(i));
  // the assumption's floor: STARNET_UNKNOWN_CHARGE_USD (default $2); a 0 or junk figure is the default, never $0
  assert.deepEqual(ledgerWith([], [receipts[1]]).unknownItems()[0].bound, { usd: 2, source: 'assumed' });
  assert.equal(ledgerWith([prior], [receipts[1]], { unknownChargeUsd: 5 }).unknownItems()[0].bound.usd, 5);
  for (const bad of [0, -1, NaN, Infinity, '3', undefined]) assert.equal(ledgerWith([], [receipts[1]], { unknownChargeUsd: bad }).unknownItems()[0].bound.usd, 2, 'figure ' + String(bad));
}

// ---- the host reads the charge a damaged line still records: a COMPLETE usd field of a single row, never $0 ----
{
  // sliced by its neighbours: its regexes hold quotes and braces the scanner (sidecarFunctionSource) cannot tell from code
  const src = readSidecarSource(), from = src.indexOf('function damagedSpendReceipt('), to = src.indexOf('function spendRowOf(', from);
  assert.ok(from > 0 && to > from && to - from < 3000, 'damagedSpendReceipt found');
  const receiptOf = vm.runInNewContext('(' + src.slice(from, to).trim() + ')', { crypto });
  const torn = '{"runId":"r-torn","agentId":"nova","turns":2,"usd":0.7,"tokens":120,"mod';
  assert.equal(receiptOf(torn).recordedUsd, 0.7, 'usd is a row\'s 4th field: a row torn after it still records it');
  assert.equal(receiptOf(torn).runId, receiptOf(torn).runId, 'the same bytes keep the same identity');
  assert.equal(receiptOf(torn).runId, 'damaged-' + crypto.createHash('sha256').update(torn).digest('hex').slice(0, 24), 'identity unchanged: the line\'s hash');
  for (const [line, why] of [['{"runId":"r","agentId":"a","turns":1,"usd":0.1', 'the tail of a torn number is not its value'],
    ['{"runId":"r","agentId":"a","turns":1,"usd":0,"tokens":3,', 'a $0 figure proves nothing (an unpriced or cut-off row books a $0 floor)'],
    ['{"runId":"a","agentId":"x","usd":0.5,"tok{"runId":"b","agentId":"x","usd":0.25,"m', 'two rows on one line: neither figure is the line\'s'],
    ['{"runId":"lost-tail","agentId":"agent","us', 'no figure at all']]) assert.equal(receiptOf(line).recordedUsd, undefined, why);
  const glued = '{"runId":"old-a","agentId":"nova","model":"deepseek/deepseek-chat","usd":0.1';
  assert.equal(receiptOf(glued + '{"runId":"old-b","agentId":"agent","usd":0.2}', glued).recordedUsd, undefined, 'a glued row\'s whole figure is never the fragment\'s');
}

// ---- per pool: only an item with no bound refuses, only a chosen pool that contains it, naming its way out ----
{
  const open = ledgerWith([prior], [{ runId: 'other', agentId: 'scout', ts: NOW - 60000 }]);
  assert.equal(makeBudget({ caps: { agent: 5 }, ledger: open, clock, strictScope: chosen }).check('r', 'nova', 0, NOW), null, 'another agent\'s run is outside this agent\'s pool');
  const agentRefusal = makeBudget({ caps: { agent: 5 }, ledger: open, clock, strictScope: chosen }).check('r', 'scout', 0, NOW);
  assert.deepEqual([agentRefusal.unknown, agentRefusal.code, agentRefusal.cause, agentRefusal.scope, agentRefusal.countAsUsd], [true, 'spend_history_unavailable', 'unsettled', 'agent', 2]);
  assert.equal(agentRefusal.exit, 'press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set PER AGENT to 0', 'the refusal names its one-click exit');
  const noAgent = ledgerWith([], [{ runId: 'legacy', agentId: '', ts: NOW - 60000 }]);
  assert.equal(makeBudget({ caps: { agent: 5 }, ledger: noAgent, clock, strictScope: chosen }).check('r', 'nova', 0, NOW).scope, 'agent', 'a run of no named agent may be in any agent\'s pool');
  const globalB = makeBudget({ caps: { day: 25, global: 100 }, ledger: ledgerWith([prior], [{ runId: 'old-open', agentId: 'scout', ts: NOW - 3 * DAY }]), clock, strictScope: chosen });
  const g = globalB.check('r', 'nova', 0, NOW);
  assert.deepEqual([g.scope, g.cause], ['global', 'unsettled'], 'the global pool contains every item');
  assert.match(g.exit, /, or set GLOBAL to 0$/);
  assert.equal(globalB.resume('global'), null, 'RESUME never adds headroom over spend nobody can count');
  assert.equal(globalB.resume('day'), 50, '...but the day pool, which cannot contain that run, still resumes');
  const day = makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior], [{ runId: 'now-open', agentId: 'scout', ts: NOW - 60000 }]), clock, strictScope: chosen });
  assert.match(day.check('r', 'nova', 0, NOW).exit, /set PER DAY to 0/, 'inside the window: the day pool refuses, naming PER DAY');
  // the shipped soft rail nobody chose is not enforced over it (as before): it never bricks a run, and reads as unknown
  const soft = makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior], [{ runId: 'now-open', agentId: 'scout', ts: NOW - 60000 }]), clock, strictScope: () => false });
  assert.equal(soft.check('r', 'nova', 0, NOW), null);
  assert.equal(soft.status(NOW).day.usd, null, 'a pool that contains an item with no bound reads as unknown, never a guessed figure');
  assert.deepEqual(soft.status(NOW).unknown, { items: 1, unbounded: 1, countedUsd: 0 });
  // a broken classifier fails closed: every governed pool counts as chosen
  assert.equal(makeBudget({ caps: { global: 100 }, ledger: open, clock, strictScope: () => { throw new Error('boom'); } }).check('r', 'nova', 0, NOW).cause, 'unsettled');
}
{
  // the bound decides an ORDINARY cap stop (the worst case is RESUME, never a refusal), and the soft rail counts it too
  const counted = () => ledgerWith([{ runId: 'p', agentId: 'agent', usd: 0.95, ts: NOW - 60000 }], [tornLine]);
  for (const strictScope of [chosen, () => false]) {
    const B = makeBudget({ caps: { day: 2.5 }, ledger: counted(), clock, strictScope });
    const stop = B.check('r', 'agent', 0, NOW);
    assert.ok(stop && stop.scope === 'day' && near(stop.usd, 2.95) && stop.cap === 2.5 && !stop.unknown, 'an ordinary day cap stop: ' + JSON.stringify(stop));
    assert.equal(B.resume('day'), 5);
    assert.equal(B.check('r', 'agent', 0, NOW), null, 'after RESUME the run proceeds');
  }
}
{
  // a failed write and an unreadable record list nothing to count: they keep their refusals, each naming its way out
  const W = makeLedger({ clock, io: { readAll: () => [], append() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  W.record({ runId: 'x', usd: 1 });
  const w = makeBudget({ caps: { day: 5 }, ledger: W, clock }).check('r', 'a', 0, NOW);
  assert.deepEqual([w.unknown, w.cause, w.exit], [true, 'write', 'restart StarNet: it replays the spend it could not save']);
  const R = makeLedger({ clock, io: { readAll() { throw Object.assign(new Error('bad'), { code: 'EIO' }); }, append() {} } });
  const rb = makeBudget({ caps: { day: 5 }, ledger: R, clock });
  const r = rb.check('r', 'a', 0, NOW);
  assert.deepEqual([r.unknown, r.cause, r.scope], [true, 'read', 'day']);
  assert.equal(r.exit, 'restart StarNet; if it stays, fix the spend files in your workspaces folder, or set PER DAY to 0 in SETTINGS › SPENDING LIMITS');
  assert.deepEqual([rb.resume('day'), rb.status(NOW).day.usd, 'unknown' in rb.status(NOW)], [null, null, false], 'nothing to count: no resume, no figure, no unknown block');
}

// ---- one click settles every item at the figure its row names, and the booking says which figure it was ----
{
  const L = ledgerWith([], [{ runId: 'damaged-q', agentId: 'nova', kind: 'damaged', lineHash: 'e'.repeat(64), recordedUsd: 0.7 }, { runId: 'open', agentId: 'agent', ts: NOW - 1000 }]);
  const [dq, op] = L.unknownItems();
  const r1 = L.settleUnsettled('damaged-q', dq.countAs.usd, dq.countAs.source);
  assert.deepEqual([r1.usd, r1.attested, r1.attestedAs, r1.resolvesLine], [0.7, true, 'recorded', 'e'.repeat(64)]);
  const r2 = L.settleUnsettled('open', op.countAs.usd, op.countAs.source);
  assert.deepEqual([r2.usd, r2.attestedAs, r2.ts], [2, 'assumed', NOW - 1000], 'an assumption is booked as one, at the dispatch time');
  assert.deepEqual(L.attestedFor('open'), { usd: 2, attestedAs: 'assumed' });
  assert.throws(() => L.settleUnsettled('open', 2, 'assumed'), e => e.code === 'not_unsettled', 'never twice');
  assert.deepEqual([L.health().complete, L.unknownItems().length], [true, 0], 'history is exact again');
  assert.equal(L.record({ runId: 'm', usd: 1, attested: true, attestedAs: 'bogus' }).attestedAs, 'entered', 'an unknown word is never recorded as a one-click booking');
  // the run's history row takes the same word, or the boot scan (index.js syncInterruptedRunHistory) re-appends it forever
  const runs = [];
  const s = makeRunStore({ io: { readAll: () => runs.slice(), append: e => runs.push(e) }, clock });
  s.record({ runId: 'open', agentId: 'agent', reason: 'interrupted', usd: 0, spendUnknown: true, model: 'm' });
  const stamped = s.settleSpend('open', 2, 'assumed');
  assert.ok(stamped && stamped.spendSettled === 'assumed' && stamped.usd === 2 && stamped.spendUnknown !== true, 'restamped: ' + JSON.stringify(stamped));
}

// ---- through the governor and the loop, as runOnceCore wires runBudget: no refusal without its exit, no stop RESUME can't clear ----
(async () => {
  const BillingClass = require('../sidecar/billing-class.js');   // the one governor (spend-governor S2)
  function loopUnder(budget) {
    const governor = BillingClass.makeGovernor({ budget, classOfProvider: () => 'metered' });
    return async runId => {
      let calls = 0; const events = [];
      const provider = { priceOf: () => ({ in: 0, out: 0 }), contextLimit: () => 0, stream: async function* () { calls++; yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' }; } };
      const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: (name, payload) => events.push({ name, payload }),
        cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }), model: 'm', agentId: 'agent', runId,
        budget: { check: spent => governor.admit('run', { providerId: 'openrouter', agentId: 'agent', runId, spentUsd: spent }) } });
      return { res, calls, events, error: (events.find(e => e.name === 'agent.run.error') || {}).payload, end: (events.find(e => e.name === 'agent.run.end') || {}).payload };
    };
  }
  const proceeds = await loopUnder(makeBudget({ caps: { day: 25 }, ledger: ledgerWith([prior], [tornLine]), clock, strictScope: chosen }))('r-proceeds');
  assert.deepEqual([proceeds.calls, proceeds.res.reason, proceeds.error], [1, 'done', undefined], 'a capped run proceeds over a torn line');

  const capped = makeBudget({ caps: { day: 2.5 }, ledger: ledgerWith([{ runId: 'p', agentId: 'agent', usd: 0.95, ts: NOW - 60000 }], [tornLine]), clock, strictScope: chosen });
  const stopped = await loopUnder(capped)('r-stopped');
  assert.deepEqual([stopped.calls, stopped.res.reason, stopped.end.budgetScope, stopped.end.budgetCapUsd, stopped.error], [0, 'budget', 'day', 2.5, undefined], 'the bound causes an ordinary day cap stop, not a refusal');
  assert.equal(capped.resume('day'), 5);
  assert.equal((await loopUnder(capped)('r-resumed')).calls, 1, 'and RESUME clears it');

  const refused = await loopUnder(makeBudget({ caps: { global: 100 }, ledger: ledgerWith([prior], [{ runId: 'open', agentId: 'scout', ts: NOW - 60000 }]), clock, strictScope: chosen }))('r-refused');
  assert.deepEqual([refused.calls, refused.res.reason, refused.res.failureCode], [0, 'error', 'spend_history_unavailable'], 'an item with no bound under a chosen limit that contains it: no paid call');
  assert.equal(refused.error.message, 'An earlier run was interrupted before its spend was recorded and had no per-run limit to count it at, so the spending limits you set can’t be checked. ' +
    'Press COUNT AS $2.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set GLOBAL to 0.', 'the refusal names every one-click exit');
  const headline = friendlyError(refused.error.message);
  assert.equal(headline.kind, 'spend_unknown');
  assert.match(headline.userMessage, /Press COUNT AS \$2\.00 or enter its charge in SETTINGS › SPENDING LIMITS, or set GLOBAL to 0\.$/, 'the chat headline keeps the exit word for word: ' + headline.userMessage);

  const unread = await loopUnder(makeBudget({ caps: { day: 5 }, ledger: makeLedger({ clock, io: { readAll() { throw Object.assign(new Error('bad'), { code: 'EIO' }); }, append() {} } }), clock }))('r-unread');
  assert.match(unread.error.message, /^Spend history could not be read, so the spending limits you set can’t be checked\. Restart StarNet; if it stays, fix the spend files in your workspaces folder, or set PER DAY to 0 in SETTINGS › SPENDING LIMITS\.$/);
  assert.match(friendlyError(unread.error.message).userMessage, /set PER DAY to 0/, 'the headline keeps that exit too');
  const thrown = await loopUnder({ check() { throw new Error('ledger gone'); } })('r-thrown');
  assert.match(thrown.error.message, /^The spending check failed, so the spending limits you set can’t be checked\. Restart StarNet; SETTINGS › SPENDING LIMITS shows what the spend record holds\.$/, 'a check that throws names its own exit: ' + thrown.error.message);
  console.log('unknown spend state: every item counted at its bound in the pools that contain it (never $0), ordinary cap stops RESUME clears, only an unbounded item refuses with its one-click exit, write/read/check exits named, one-click settle says which figure PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
