/* Chosen caps remain strict until an unknown charge is explicitly settled (DECISIONS 2026-09-23).
   An estimate, prior run cap, old timestamp or different agent cannot silently authorize more paid calls. */
'use strict';
const A = require('./_assert.js');
const { makeLedger } = require('../sidecar/ledger.js');
const { makeBudget } = require('../sidecar/budget.js');
const { makeGovernor } = require('../sidecar/billing-class.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { friendlyError } = require('../frontend/app/friendlyerror.js');
const DAY = 86400000, NOW = 10 * DAY, clock = { now: () => NOW };
const cases = [
  { runId: 'damaged-recorded', kind: 'damaged', lineHash: 'a'.repeat(64), recordedUsd: 0.1 },
  { runId: 'damaged-assumed', kind: 'damaged', lineHash: 'b'.repeat(64) },
  { runId: 'interrupted-capped', agentId: 'agent', ts: NOW - 1000, runCapUsd: 0.5 },
  { runId: 'interrupted-open', agentId: 'agent', ts: NOW - 1000 },
  { runId: 'old-capped', agentId: 'agent', ts: NOW - 3 * DAY, runCapUsd: 0.5 },
  { runId: 'other-agent', agentId: 'someone-else', ts: NOW - 1000, runCapUsd: 0.5 },
  { runId: 'skill-eval-test-1-before-0123456789ab', agentId: 'agent', ts: NOW - 1000, runCapUsd: 0.08 }
];
function setup(receipt, caps, strictScope, knownUsd) {
  const rows = [{ runId: 'prior', agentId: 'agent', usd: knownUsd == null ? 0.5 : knownUsd, ts: NOW - 500 }];
  const L = makeLedger({ clock, io: { readAll: () => rows.slice(), unsettled: () => [receipt], append: r => rows.push(r), beginRun() {}, finishRun() {} } });
  const B = makeBudget({ caps, ledger: L, clock, strictScope });
  return { L, B, rows };
}
(async () => {
  for (const receipt of cases) for (const scope of ['agent', 'day', 'global']) {
    const { L, B } = setup(receipt, { [scope]: 25 }, () => true);
    const label = receipt.runId + '/' + scope;
    const verdict = B.check('next', 'agent', 0, NOW);
    A.eq(verdict && [verdict.unknown, verdict.code, verdict.scope], [true, 'spend_history_unavailable', scope], label + ': chosen cap refuses unknown charge');
    A.ok(verdict && /COUNT AS|enter its charge/.test(verdict.exit), label + ': recovery exit names explicit settlement');
    A.eq(B.resume(scope), null, label + ': RESUME is not implicit settlement');
    A.eq(L.health().complete, false, label + ': estimate never makes history known');
    A.ok(L.unknownItems()[0].countAs.usd > 0, label + ': settlement estimate remains available');
    const st = B.status(NOW);
    if (scope !== 'agent') A.eq(st[scope].usd, null, label + ': uncertain totals remain unknown');
    const settled = L.settleUnsettled(receipt.runId, 0.1, 'entered');
    A.ok(!!settled, label + ': explicit settlement is durable through ledger owner');
    A.eq(B.check('settled-next', 'agent', 0, NOW), null, label + ': settled history allows an under-cap call');
  }
  for (const receipt of cases) {
    const { B } = setup(receipt, { day: 25 }, () => false, 26);
    A.eq(B.check('soft-next', 'agent', 0, NOW), null, receipt.runId + ': shipped soft-only rail remains unenforced while history unknown');
    A.eq(B.resume('day'), null, receipt.runId + ': soft RESUME cannot attest an uncertain charge either');
    A.eq(setup(receipt, {}, () => true).B.check('uncapped', 'agent', 0, NOW), null, receipt.runId + ': no chosen pool means no history refusal');
  }
  {
    const { B } = setup(cases[0], { day: 25 }, () => { throw new Error('classifier failed'); });
    const refused = B.check('r', 'agent', 0, NOW);
    A.eq(refused && refused.code, 'spend_history_unavailable', 'broken strict classifier remains fail closed');
  }
  for (const cls of ['metered', 'managed', 'subscription', 'local']) {
    const { B } = setup(cases[0], { day: 25 }, () => true);
    let checks = 0;
    const governor = makeGovernor({ budget: { check(...args) { checks++; return B.check(...args); } }, classOfProvider: () => cls });
    let calls = 0; const events = [];
    const result = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], agentId: 'agent', runId: 'loop-' + cls, model: 'fixture/m',
      provider: { contextLimit: () => 0, async *stream() { calls++; yield { type: 'text', delta: 'finished' }; yield { type: 'done', finishReason: 'stop' }; } },
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), emit: (name, payload) => events.push({ name, payload }),
      budget: { check: spentUsd => governor.admit('run', { providerId: 'fixture', runId: 'loop-' + cls, agentId: 'agent', spentUsd }) } });
    const paid = cls === 'metered' || cls === 'managed';
    A.eq(calls, paid ? 0 : 1, cls + ': actual provider call count obeys payer policy');
    A.eq(result.reason, paid ? 'error' : 'done', cls + ': loop terminal outcome follows admission');
    A.eq(checks > 0, paid, cls + ': unmetered routes do not consult dollar caps');
    if (paid) {
      A.eq(result.failureCode, 'spend_history_unavailable', cls + ': typed refusal preserved');
      const error = events.find(e => e.name === 'agent.run.error');
      A.ok(error && /damaged/.test(error.payload.message) && /COUNT AS/.test(error.payload.message), cls + ': damaged receipt named truthfully with explicit exit');
      A.ok(error && !/no per-run limit/.test(error.payload.message), cls + ': no false claim about a bounded receipt');
      A.ok(error && /COUNT AS/.test(friendlyError(error.payload.message).userMessage), cls + ': chat headline keeps the explicit settlement exit');
    }
  }
  A.report('spend-strict-unknown.test');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
