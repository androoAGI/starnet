/* node test/budget.tokens.test.js — the governor's daily SUBSCRIPTION usage pool (2026-10-11).
   A pool in weighted tokens beside the $ scopes: evaluateTokens is pure; checkTokens sums ledger.tokensForDay + every
   in-flight run, blocks with { scope:'day', unit:'tokens', tokens, cap } at the cap, never blocks when off (0) or when
   spend history cannot be read (an estimate must not brick a subscription); resumeTokens grants session headroom; the
   $ check()/evaluate() decisions are untouched and no budget.threshold is ever emitted for tokens. */
'use strict';
const A = require('./_assert.js');
const B = require('../sidecar/budget.js');
const { makeLedger } = require('../sidecar/ledger.js');

// ---- pure ----
A.eq(B.evaluateTokens(100, 50), { blocked: false, tokens: 50, cap: 100, frac: 0.5 }, 'under the cap');
A.eq(B.evaluateTokens(100, 100).blocked, true, 'at the cap blocks');
A.eq(B.evaluateTokens(0, 1e9).blocked, false, 'cap 0 = off');
A.eq(B.evaluateTokens(null, 1e9).blocked, false, 'cap null = off');
A.eq(B.evaluateTokens(Infinity, 1e9).blocked, false, 'cap Infinity = off');
A.eq(B.evaluateTokens(100, -5).tokens, 0, 'negative use clamps to 0');

function rig(opts) {
  opts = opts || {};
  let t = 100000;
  const rows = (opts.rows || []).slice();
  const io = { readAll() { if (opts.readFail) { const e = new Error('nope'); e.code = 'EIO'; throw e; } return rows.slice(); }, append(e) { rows.push(e); },
    unsettled: () => opts.unsettled || [] };
  const ledger = makeLedger({ io, clock: { now: () => t }, dayMs: 50000 });
  const emitted = [];
  const budget = B.makeBudget({ caps: opts.caps || {}, tokenCaps: opts.tokenCaps, ledger, clock: { now: () => t }, dayMs: 50000 });
  return { budget, ledger, emitted, at: v => { t = v; } };
}

// ---- off by default; on via tokenCaps / setTokenCaps ----
{
  const { budget, ledger } = rig();
  ledger.record({ runId: 'x', agentId: 'a', usd: 0, weightedTokens: 1e9 });
  A.eq(budget.checkTokens('r', 'a', 1e9, 0), null, 'no token cap = never blocks');
  A.eq(budget.status().tokenDay, null, 'status.tokenDay is null while the pool is off');
  budget.setTokenCaps({ day: 15000 });
  A.eq(budget.tokenCaps(), { day: 15000 }, 'setTokenCaps applies live');
  A.eq(budget.checkTokens('r', 'a', 0, 0), { scope: 'day', unit: 'tokens', tokens: 1e9, cap: 15000 }, 'the ledger tokens alone trip it');
  budget.setTokenCaps({ day: 0 });
  A.eq(budget.checkTokens('r', 'a', 0, 0), null, '0 turns it off again');
  budget.setTokenCaps({ day: -3 });
  A.eq(budget.tokenCaps(), { day: 0 }, 'a junk cap reads as off');
}

// ---- finished + live runs ----
{
  const { budget, ledger } = rig({ tokenCaps: { day: 15000 } });
  ledger.record({ runId: 'done1', agentId: 'a', usd: 0, weightedTokens: 10500 });
  A.eq(budget.checkTokens('live1', 'a', 2000, 0), null, '10,500 booked + 2,000 live < 15,000');
  A.eq(budget.status().tokenDay, { tokens: 12500, cap: 15000, base: 15000 }, 'status shows booked + live');
  const b = budget.checkTokens('live2', 'b', 3000, 0);
  A.eq(b, { scope: 'day', unit: 'tokens', tokens: 15500, cap: 15000 }, 'another run\'s live tokens count toward the shared pool');
  budget.clearLive('live2');
  A.eq(budget.checkTokens('live1', 'a', 2000, 0), null, 'clearLive drops a finished run\'s live tally');
  A.eq(budget.checkTokens(null, 'a', 999999, 0), null, 'a null runId (a side-effect-free aux gate) records nothing');
  A.eq(budget.tokensUsed(0), 12500, 'tokensUsed = booked + live');
  // the $ path is untouched: no token pool influence on check()
  A.eq(budget.check('live1', 'a', 0, 0, null), null, '$ check still proceeds (no $ cap governed)');
  // window
  const later = rig({ tokenCaps: { day: 15000 } });
  later.ledger.record({ runId: 'old', agentId: 'a', usd: 0, weightedTokens: 20000 });
  A.ok(later.budget.checkTokens(null, 'a', 0, 0), 'blocked inside the window');
  later.at(100000 + 50001);
  A.eq(later.budget.checkTokens(null, 'a', 0, 0), null, 'a rolling window: the row ages out after dayMs');
}

// ---- resume ----
{
  const { budget, ledger } = rig({ tokenCaps: { day: 10000 } });
  ledger.record({ runId: 'd', agentId: 'a', usd: 0, weightedTokens: 10000 });
  A.ok(budget.checkTokens(null, 'a', 0, 0), 'tripped');
  A.eq(budget.resumeTokens(), 20000, 'resume grants one more base cap of headroom');
  A.eq(budget.checkTokens(null, 'a', 0, 0), null, 'and the pool proceeds');
  A.eq(budget.status().tokenDay, { tokens: 10000, cap: 20000, base: 10000 }, 'status reports the effective cap incl. resume');
  A.eq(budget.resumeTokens(500), 20500, 'an explicit amount');
  const off = rig();
  A.eq(off.budget.resumeTokens(), null, 'resume on an off pool -> null');
}

// ---- unknown history never blocks ----
{
  const broken = rig({ tokenCaps: { day: 1 }, readFail: true });
  A.eq(broken.budget.checkTokens('r', 'a', 5, 0), null, 'an unreadable spend record does not block the token pool');
  A.eq(broken.budget.status().tokenDay.tokens, null, 'and status says the figure is unknown (null), never a guessed 0');
  A.eq(broken.budget.tokensUsed(0), null, 'tokensUsed is null');
  // an interrupted run's unknown $ does not hide the token rows that DID land
  const unsettled = rig({ tokenCaps: { day: 5000 }, rows: [{ runId: 's', agentId: 'a', usd: 0, ts: 99999, weightedTokens: 6000 }], unsettled: [{ runId: 'lost', agentId: 'a', ts: 99000 }] });
  A.eq(unsettled.ledger.health().readError, 'UNSETTLED_SPEND', 'fixture: an unsettled receipt');
  A.eq(unsettled.budget.checkTokens(null, 'a', 0, 0), { scope: 'day', unit: 'tokens', tokens: 6000, cap: 5000 }, 'UNSETTLED_SPEND still reads the token rows');
  const noFn = B.makeBudget({ tokenCaps: { day: 10 }, ledger: { usdForDay: () => 0, totalUsd: () => 0, health: () => ({ complete: true, durable: true }) } });
  A.eq(noFn.checkTokens('r', 'a', 11, 0), { scope: 'day', unit: 'tokens', tokens: 11, cap: 10 }, 'a ledger predating tokensForDay counts live runs only');
}

// ---- no threshold events, no $ scope leakage ----
{
  const { budget, ledger } = rig({ caps: { day: 100 }, tokenCaps: { day: 10 } });
  ledger.record({ runId: 'd', agentId: 'a', usd: 0, weightedTokens: 50 });
  const ev = [];
  A.eq(budget.check('r', 'a', 0, 0, (n, p) => ev.push([n, p])), null, 'the $ day pool ($0 of $100) proceeds even with the token pool tripped');
  A.eq(ev.length, 0, 'no budget.threshold for tokens');
  const st = budget.status();
  A.eq([st.day.usd, st.day.cap], [0, 100], 'the $ day status is untouched');
  A.eq(Object.keys(st.caps).sort(), ['day'], 'status.caps stays the $ pool shape');
}

A.report('budget.tokens');
