'use strict';
const assert = require('node:assert/strict');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const { makeEvaluationAccounting } = require('../sidecar/skill-evaluation-accounting.js');
const pending = new Map(), rows = [];
const io = { readAll: () => rows.slice(), unsettled: () => [...pending.values()], beginRun: r => pending.set(r.runId, r), finishRun: e => pending.delete(e.runId), append: e => rows.push(e) };
const ledger = makeLedger({ io, clock: { now: () => 42 } });
const a = makeEvaluationAccounting({ ledger, agentId: 'owner', provider: 'test', model: 'test/model' });
a.beforeRun({ runId: 'paid' });
assert.equal(pending.size, 1);
a.onRun({ runId: 'paid', result: { usd: 0.02, tokens: 19, turns: 1 } });
assert.equal(pending.size, 0); assert.equal(ledger.totalUsd(), 0.02);
a.beforeRun({ runId: 'interrupted' });
assert.throws(() => a.onRun({ runId: 'interrupted', result: { accountingIncomplete: true } }), /incomplete/);
assert.equal(a.canContinue(), false); assert.equal(rows.length, 1);
assert.equal(ledger.health().complete, false, 'incomplete spend is visible before restart');
assert.equal(ledger.unsettledRuns()[0].runId, 'interrupted');
const strict = makeBudget({ ledger, caps: { day: 1 }, clock: { now: () => 42 } });
const fresh = makeEvaluationAccounting({ ledger });
assert.equal(fresh.canContinue(), true, 'a fresh evaluator has no local failures');
// A chosen cap refuses unsettled spend until the Commander explicitly confirms its charge. A bound is not settlement.
const unknown = strict.check(null, 'owner', 0);
assert.equal(unknown.code, 'spend_history_unavailable'); assert.equal(unknown.unknown, true); assert.equal(unknown.countAsUsd, 0.08);
const tight = makeBudget({ ledger, caps: { day: 0.09 }, clock: { now: () => 42 } }).check(null, 'owner', 0);
assert.ok(tight && tight.scope === 'day' && tight.unknown, 'a lower chosen cap also refuses unknown spend: ' + JSON.stringify(tight));
const soft = makeBudget({ ledger, caps: { day: 25 }, strictScope: () => false, clock: { now: () => 42 } });
assert.equal(soft.check(null, 'owner', 0), null, 'shipped soft-only policy remains permissive but truthful');
assert.equal(soft.status().accounting.complete, false);
const reopened = makeLedger({ io, clock: { now: () => 43 } });
assert.equal(reopened.health().complete, false);
assert.equal(reopened.unsettledRuns()[0].runId, 'interrupted');
assert.equal(reopened.totalUsd(), 0.02);
ledger.settleUnsettled('interrupted', 0.08, 'limit');
assert.equal(strict.check(null, 'owner', 0), null, 'explicit COUNT AS settles the charge under the $1 cap');
const settledTight = makeBudget({ ledger, caps: { day: 0.09 }, clock: { now: () => 42 } }).check(null, 'owner', 0);
assert.ok(settledTight && Math.abs(settledTight.usd - 0.1) < 1e-9 && !settledTight.unknown, 'the same confirmed charge now hits the lower cap as known dollars');
const denied = makeEvaluationAccounting({ ledger: { beginRun: () => false, markUnsettled: () => false, recordStrict: () => { throw Error('must not settle'); } } });
assert.throws(() => denied.beforeRun({ runId: 'no-disk' }), /durably recorded/); assert.equal(denied.canContinue(), false);
const failedSettlement = makeEvaluationAccounting({ ledger: { beginRun: () => true, markUnsettled: () => false, recordStrict: () => { throw Error('disk full'); } } });
failedSettlement.beforeRun({ runId: 'cannot-save' });
assert.throws(() => failedSettlement.onRun({ runId: 'cannot-save', result: { usd: 0.01, tokens: 3 } }), /disk full/);
assert.equal(failedSettlement.canContinue(), false);
for(const reason of ['error','cancelled']) { const f=makeEvaluationAccounting({ledger}); f.beforeRun({runId:reason}); assert.throws(()=>f.onRun({runId:reason,result:{reason,usd:0,tokens:0}}),/incomplete/); assert.equal(pending.has(reason),true); }
// The dispatch receipt records the billing source the host knew (StarNet credits or the Commander's own key), so an
// unsettled evaluation is never shown as BILLING SOURCE UNKNOWN (security-storage-07). Absent stays unknown.
for (const managed of [true, false, undefined]) {
  const metas = [];
  const sourced = makeEvaluationAccounting({ ledger: { beginRun: (runId, agentId, meta) => { metas.push(meta); return true; }, markUnsettled: () => true, recordStrict: () => true },
    agentId: 'owner', provider: 'openrouter', model: 'test/model', managed });
  sourced.beforeRun({ runId: 'sourced' });
  assert.equal(metas[0].managed, managed, 'billing source on the receipt: ' + managed);
}
// An unmetered provider (Ollama, a subscription) bills nothing per token: its unpriced usage settles at $0, with no
// dispatch receipt (the run host writes none for it), and never makes station spend history unknown.
{
  const localPending = new Map(), localRows = [];
  const localIo = { readAll: () => localRows.slice(), unsettled: () => [...localPending.values()], beginRun: r => localPending.set(r.runId, r), finishRun: e => localPending.delete(e.runId), append: e => localRows.push(e) };
  const localLedger = makeLedger({ io: localIo, clock: { now: () => 42 } });
  const localStrict = makeBudget({ ledger: localLedger, caps: { day: 1 }, clock: { now: () => 42 } });
  const local = makeEvaluationAccounting({ ledger: localLedger, budget: localStrict, agentId: 'owner', provider: 'ollama', model: 'qwen3:8b', unmetered: true });
  assert.deepEqual(local.beforeRun({ runId: 'local' }), { ok: true, unmetered: true }, 'unmetered admission tells the runner to settle at $0');
  assert.equal(localPending.size, 0, 'an unmetered dispatch writes no receipt');
  local.onStream({ runId: 'local', spentUsd: 0, accountingIncomplete: true });
  local.onRun({ runId: 'local', result: { reason: 'done', usd: 0, tokens: 540, turns: 1, unpricedUsage: [{ model: 'qwen3:8b', tokensIn: 500, tokensOut: 40 }] } });
  assert.equal(local.canContinue(), true, 'unpriced unmetered usage is not unknown spend');
  assert.equal(localLedger.health().complete, true, 'station spend history stays complete');
  assert.equal(localStrict.check(null, 'other', 0), null, 'a strict cap still admits every other agent');
  assert.deepEqual([localRows[0].usd, localRows[0].tokens, localRows[0].unmetered], [0, 540, true], 'booked as a $0 unmetered row with its tokens');
  local.beforeRun({ runId: 'local-error' });
  local.onRun({ runId: 'local-error', result: { reason: 'runner-error', accountingIncomplete: true } });
  assert.equal(localLedger.health().complete, true, 'a failed unmetered case is still $0, not unsettled');
  const meteredLocal = makeEvaluationAccounting({ ledger: localLedger, budget: localStrict, agentId: 'owner', provider: 'custom', model: 'local/model' });
  assert.equal(meteredLocal.beforeRun({ runId: 'metered-unpriced' }), true, 'a metered provider still commits its receipt');
  assert.throws(() => meteredLocal.onRun({ runId: 'metered-unpriced', result: { reason: 'done', usd: 0, tokens: 540, turns: 1, unpricedUsage: [{ model: 'local/model', tokensIn: 500, tokensOut: 40 }] } }), /incomplete/, 'metered unpriced usage stays unknown');
  assert.equal(localLedger.health().readError, 'UNSETTLED_SPEND');
}
console.log('skill evaluation accounting: settled cost, interrupted restart, persistence denial, and unmetered $0 settlement PASS');
