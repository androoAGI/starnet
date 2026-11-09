/* node test/budget.test.js — cross-run spend governance. Tests the pure evaluate() decision and the
   stateful makeBudget governor against a fake ledger + a collecting emit (zero disk, zero network). */
'use strict';
const A = require('./_assert.js');
const { evaluate, makeBudget } = require('../sidecar/budget.js');

// ---- evaluate(): pure decision over caps + totals (+ overrides) ----
{
  // under all caps -> nothing blocked, nothing warned
  let r = evaluate({ day: 40, global: 100 }, { day: 10, global: 10 });
  A.eq(r.blocked, null, 'under caps -> not blocked');
  A.eq(r.warn, [], 'under the warn band -> no warnings');

  // warn band (>=80% of cap, <100%)
  r = evaluate({ day: 40, global: 100 }, { day: 33, global: 10 });
  A.eq(r.blocked, null, '82.5% of day -> warn, not block');
  A.eq(r.warn, ['day'], 'day enters the warn band');

  // at/over cap -> blocked; run<day<global priority when several are over
  r = evaluate({ day: 40, global: 100 }, { day: 40, global: 100 });
  A.eq(r.blocked, 'day', 'day at cap blocks; day precedes global in priority');

  r = evaluate({ global: 100 }, { global: 120 });
  A.eq(r.blocked, 'global', 'global over cap blocks when it is the only governed scope');

  // overrides (resume headroom) lift the effective cap
  r = evaluate({ day: 40 }, { day: 45 }, { day: 20 });
  A.eq(r.blocked, null, 'a resume override (40+20=60) clears a 45 spend');
  A.ok(Math.abs(r.scopes.day.cap - 60) < 1e-9, 'effective cap reflects the override');

  // an absent/zero/Infinity cap is ungoverned (never blocks, never appears)
  r = evaluate({ day: 0, global: Infinity }, { day: 1e9, global: 1e9 });
  A.eq(r.blocked, null, 'zero/Infinity caps are ungoverned');
  A.eq(Object.keys(r.scopes).length, 0, 'ungoverned scopes are omitted from the breakdown');
}

// fake ledger: completed-run spend by day-window + grand total, both injectable
function fakeLedger(day, total) { return { usdForDay: () => day, totalUsd: () => total }; }
function collector() { const evs = []; return { emit: (name, payload) => evs.push({ name, payload }), evs }; }

// ---- makeBudget.check(): live spend + ledger -> block + threshold emission ----
{
  const c = collector();
  const b = makeBudget({ caps: { day: 40, global: 100 }, ledger: fakeLedger(0, 0), clock: { now: () => 0 } });

  // run r1 spends $10 -> well under -> proceed, no threshold
  A.eq(b.check('r1', 'a', 10, 0, c.emit), null, '$10 of a $40 day -> proceed');
  A.eq(c.evs.length, 0, 'no threshold under the warn band');

  // r1 climbs to $33 -> 82.5% of the $40 day pool -> warn (one budget.threshold, scope day)
  A.eq(b.check('r1', 'a', 33, 0, c.emit), null, 'still under cap -> proceed');
  const warns = c.evs.filter(e => e.name === 'budget.threshold');
  A.eq(warns.length, 1, 'exactly one threshold at the warn crossing');
  A.eq(warns[0].payload.scope, 'day', 'warn names the day scope');
  A.ok(Math.abs(warns[0].payload.cap - 40) < 1e-9, 'threshold carries the effective cap');

  // re-checking in the warn band does NOT re-emit (de-duped per scope+level)
  b.check('r1', 'a', 34, 0, c.emit);
  A.eq(c.evs.filter(e => e.name === 'budget.threshold').length, 1, 'warn threshold is not re-emitted');

  // r1 hits $40 -> day pool at cap -> blocked + a second (cap-level) threshold
  const blk = b.check('r1', 'a', 40, 0, c.emit);
  A.eq(blk && blk.scope, 'day', 'day at cap -> block descriptor names day');
  A.ok(Math.abs(blk.usd - 40) < 1e-9, 'block carries the spend');
  A.eq(c.evs.filter(e => e.name === 'budget.threshold').length, 2, 'a distinct cap-level threshold fired');
}

// ---- live spend across DISTINCT runs shares the pool (the global-pool guard the reference harness lacked) ----
{
  const b = makeBudget({ caps: { global: 10 }, ledger: fakeLedger(0, 0), clock: { now: () => 0 } });
  A.eq(b.check('r1', 'a', 6, 0, null), null, 'run1 $6 of the $10 global pool -> ok');
  const blk = b.check('r2', 'b', 5, 0, null);   // r1 still live at $6 + r2 $5 = $11 > $10
  A.eq(blk && blk.scope, 'global', 'two concurrent runs together exhaust the shared global pool');
  // when run1 finishes (its spend leaves the live tally), run2 alone fits again
  b.clearLive('r1');
  A.eq(b.check('r2', 'b', 5, 0, null), null, 'after run1 clears, run2 alone is back under the pool');
}

// ---- the ledger's PERSISTED spend counts toward the pool (survives restarts) ----
{
  const b = makeBudget({ caps: { global: 10 }, ledger: fakeLedger(0, 8), clock: { now: () => 0 } });
  const blk = b.check('r1', 'a', 3, 0, null);   // 8 already on disk + 3 live = 11 > 10
  A.eq(blk && blk.scope, 'global', 'prior recorded spend (8) + this run (3) breaches the pool');
}

// ---- per-run threshold VISIBILITY: two runs that each sit in the SHARED pool's warn band each get their own
//      budget.threshold on their own bus (de-dup is keyed per run, not once-per-session) ----
{
  const cA = collector(), cB = collector();
  const b = makeBudget({ caps: { day: 40 }, ledger: fakeLedger(0, 0), clock: { now: () => 0 } });
  b.check('r1', 'a', 33, 0, cA.emit);            // r1 live $33 -> day 33/40 = warn on r1's bus
  b.check('r2', 'b', 0, 0, cB.emit);             // r1 still live $33 -> day still 33 -> r2 is ALSO in the warn band
  A.eq(cA.evs.filter(e => e.name === 'budget.threshold').length, 1, 'run1 got its own warn');
  A.eq(cB.evs.filter(e => e.name === 'budget.threshold').length, 1, 'run2 ALSO got a warn for the shared-pool crossing (per-run de-dup)');
  b.clearLive('r1');                              // forgets r1's announced crossings AND its live spend
  const cA2 = collector();
  b.check('r1', 'a', 33, 0, cA2.emit);
  A.eq(cA2.evs.filter(e => e.name === 'budget.threshold').length, 1, 'after clearLive, a fresh r1 warns again');
}

// ---- resume(): one-click headroom unblocks the scope and lets it warn again ----
{
  const c = collector();
  const b = makeBudget({ caps: { day: 40 }, ledger: fakeLedger(0, 0), clock: { now: () => 0 } });
  A.ok(b.check('r1', 'a', 40, 0, c.emit), 'day starts blocked at cap');
  const newCap = b.resume('day');                 // +40 base -> effective 80
  A.ok(Math.abs(newCap - 80) < 1e-9, 'resume grants another base-cap of headroom');
  A.eq(b.check('r1', 'a', 40, 0, c.emit), null, 'after resume the $40 spend is under the $80 effective cap');
  A.eq(b.resume('run'), null, 'resuming an ungoverned scope -> null');

  const st = b.status(0);
  A.ok(Math.abs(st.day.cap - 80) < 1e-9, 'status reports the lifted effective cap');
  A.ok(Math.abs(st.overrides.day - 40) < 1e-9, 'status exposes the override headroom');
}

// ---- resumeGuard: managed-credit hosts can fail closed before resume grants extra headroom ----
{
  const calls = [];
  const b = makeBudget({
    caps: { day: 40 },
    ledger: fakeLedger(0, 0),
    clock: { now: () => 0 },
    resumeGuard(req) {
      calls.push(req);
      return req.meta && req.meta.mode === 'managed' ? { ok: false, reason: 'managed_credits_exhausted' } : true;
    }
  });
  A.ok(b.check('r1', 'a', 40, 0, null), 'day cap starts blocked before resume');
  A.eq(b.resume('day', 40, { mode: 'managed', accountId: 'acct' }), null, 'managed-credit exhaustion vetoes budget resume');
  A.ok(Math.abs(b.status(0).overrides.day) < 1e-9, 'vetoed resume grants no override headroom');
  A.eq(calls.length, 1, 'resume guard is consulted exactly once');
  A.eq(calls[0].scope, 'day', 'guard sees the requested budget scope');
  A.eq(calls[0].nextCap, 80, 'guard sees the proposed effective cap');
  A.ok(b.resume('day', 40, { mode: 'byok' }) > 40, 'non-managed resume can still grant headroom');
}

// fuller fake ledger that also answers per-agent (the 'agent' scope) — { day, total, byAgent:{id:usd} }
function fakeLedgerFull(o) {
  o = o || {}; const byAgent = o.byAgent || {};
  return { usdForDay: () => o.day || 0, totalUsd: () => o.total || 0, usdForAgent: (a) => byAgent[a] || 0 };
}

// ---- per-agent scope: one agent's cap blocks only THAT agent (multi-agent fairness rail) ----
{
  const b = makeBudget({ caps: { agent: 5, day: 40, global: 100 }, ledger: fakeLedgerFull({}), clock: { now: () => 0 } });
  const blkA = b.check('r1', 'a', 5, 0, null);            // agent a live $5 -> hits its own $5 cap
  A.eq(blkA && blkA.scope, 'agent', 'agent a at its per-agent cap -> blocked on the agent scope');
  // a different agent b is unaffected by a's overage (its own per-agent total is $1); a's $5 still sits in the day pool
  A.eq(b.check('r2', 'b', 1, 0, null), null, 'agent b under its own per-agent cap proceeds while a is capped');
}

// ---- priority: when an agent AND the shared day pool are both over, the NARROWER agent scope is reported ----
{
  const b = makeBudget({ caps: { agent: 5, day: 40 }, ledger: fakeLedgerFull({ day: 38, byAgent: { a: 4 } }), clock: { now: () => 0 } });
  // r1(a) live $3: agent = 4(disk)+3 = 7 > 5 AND day = 38(disk)+3 = 41 > 40 — both breached
  const blk = b.check('r1', 'a', 3, 0, null);
  A.eq(blk && blk.scope, 'agent', 'agent precedes day in priority -> the run names its own per-agent overage');
}

// ---- per-agent isolation + shared pooling: each agent sees only its own spend, but the day pool aggregates all ----
{
  const b = makeBudget({ caps: { agent: 5, day: 8 }, ledger: fakeLedgerFull({}), clock: { now: () => 0 } });
  A.eq(b.check('r1', 'a', 3, 0, null), null, 'a $3: under its agent cap and the day pool');
  A.eq(b.check('r2', 'b', 3, 0, null), null, 'b sees only its OWN $3 (not a\'s) -> under its $5 cap; day a3+b3=6 still fits');
  A.eq((b.check('r2', 'b', 5, 0, null) || {}).scope, 'agent', 'b crossing its OWN per-agent cap blocks b on the agent scope');
  A.eq((b.check('r1', 'a', 3, 0, null) || {}).scope, 'day', 'a is under its own agent cap but the SHARED day pool (a3+b5=8) is exhausted');
}

// ---- the per-agent cap BLOCKS but emits NO budget.threshold ('agent' is absent from the frozen event enum) ----
{
  const c = collector();
  const b = makeBudget({ caps: { agent: 5 }, ledger: fakeLedgerFull({}), clock: { now: () => 0 } });
  const blk = b.check('r1', 'a', 5, 0, c.emit);
  A.eq(blk && blk.scope, 'agent', 'per-agent cap still blocks the run');
  A.eq(c.evs.filter(e => e.name === 'budget.threshold').length, 0, 'no budget.threshold for the agent scope (stays in-contract)');
}

// ---- strict vs soft scopes on UNCERTAIN spend history (the shipped $25/day rail must not brick paid runs) ----
{
  const begun = [];
  const uncertain = { usdForDay: () => 0, totalUsd: () => 0, health: () => ({ complete: false, durable: true }), beginRun: (id) => { begun.push(id); return true; } };
  const strictAll = makeBudget({ caps: { day: 25 }, ledger: uncertain, clock: { now: () => 0 } });
  const blk = strictAll.check('r1', 'a', 0, 0);
  A.eq(blk && blk.code, 'spend_history_unavailable', 'default: every governed scope is strict -> uncertain history refuses paid dispatch');
  const softDay = makeBudget({ caps: { day: 25 }, ledger: uncertain, clock: { now: () => 0 }, strictScope: s => s !== 'day' });
  // GHSA-2hpj #8: only the SOFT shipped day rail governs -> work nobody watches pauses; a watched run is not bricked
  const pausedRun = softDay.check('r2u', 'a', 0, 0);
  A.eq(pausedRun && [pausedRun.code, pausedRun.paused, pausedRun.scope], ['spend_history_unavailable', true, 'day'], 'soft rail + uncertain history: unattended work pauses');
  A.ok(begun.indexOf('r2u') < 0, 'a paused run records no dispatch receipt');
  A.eq(softDay.check('r2', 'a', 0, 0, null, null, { attended: true }), null, 'only the SOFT shipped day rail governs -> a watched run is not bricked');
  A.ok(begun.indexOf('r2') >= 0, 'the dispatch receipt is still recorded on the soft path');
  A.eq(softDay.status(0).day.usd, null, 'status still reports the day spend as UNKNOWN (never a guessed $0)');
  const mixed = makeBudget({ caps: { day: 25, global: 100 }, ledger: uncertain, clock: { now: () => 0 }, strictScope: s => s !== 'day' });
  const blk2 = mixed.check('r3', 'a', 0, 0);
  A.eq(blk2 && blk2.scope, 'global', 'an explicitly chosen cap alongside the soft rail keeps fail-closed, naming the strict scope');
  const broken = makeBudget({ caps: { day: 25 }, ledger: uncertain, clock: { now: () => 0 }, strictScope: () => { throw new Error('boom'); } });
  const blk3 = broken.check('r4', 'a', 0, 0);
  A.eq(blk3 && blk3.code, 'spend_history_unavailable', 'a broken classifier fails CLOSED');
  const known = { usdForDay: () => 30, totalUsd: () => 30, health: () => ({ complete: true, durable: true }), beginRun: () => true };
  const softKnown = makeBudget({ caps: { day: 25 }, ledger: known, clock: { now: () => 0 }, strictScope: s => s !== 'day' });
  const cap = softKnown.check('r5', 'a', 0, 0);
  A.eq(cap && cap.scope, 'day', 'with KNOWN history the soft rail still stops the run at its cap');
}
A.report('budget.test');
