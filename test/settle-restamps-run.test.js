/* test/settle-restamps-run.test.js — settling an interrupted run makes its spend KNOWN everywhere, durably.
   SETTINGS › SPENDING LIMITS › SETTLE (POST /api/budget/settle) booked the Commander's figure in the spend ledger
   only. The run's history row (runstore, reason 'interrupted') kept spendUnknown:true / usd 0, so INSIGHTS still
   counted it as spend-unknown and left its dollars out while SPENDING LIMITS' LIFETIME included them, and the run
   row still read "spend unknown" (spend-truth lane B12, 2026-10-08; customers Kevin, Malcolm, Jamal, Dame).
   Store level, real file IO: settle → restart → still settled; a later recovery-status change never re-opens it;
   the ledger names the attested figure so the host can heal a row the settle could not restamp. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRunStore } = require('../sidecar/runstore.js');
const { makeLedger } = require('../sidecar/ledger.js');
const { foldInsights } = require('../sidecar/insights.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-restamp-'));
const file = path.join(dir, 'runs.jsonl');
// the host's shape: one JSON row per line, appended; a reload reads every line back (sidecar/index.js runsIo)
const fileIo = {
  readAll() { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } },
  append(entry) { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); }
};
let clk = 1000;
const clock = { now: () => clk };
try {
  let s = makeRunStore({ io: fileIo, clock });
  s.record({ runId: 'done1', agentId: 'agent', reason: 'done', usd: 0.25, model: 'm' });
  clk = 2000;
  // exactly what the host's boot scan records for a run the process died inside (index.js syncInterruptedRunHistory)
  s.record({ runId: 'int1', agentId: 'agent', provider: 'openrouter', reason: 'interrupted', turns: 3, tokens: 0, usd: 0, spendUnknown: true, model: 'm',
    title: 'Fix the build', recoveryStatus: 'needs_review', error: 'interrupted: StarNet stopped mid-action; an action may already have happened and needs review before continuing' });
  A.eq(foldInsights(s.all(), { nowMs: 5000 }).spendUnknownRuns, 1, 'before the settle INSIGHTS names the run as spend-unknown');

  // ---- the settle restamps the row ----
  A.eq(typeof s.settleSpend, 'function', 'the run store can settle an interrupted run\'s spend');
  const stamped = s.settleSpend && s.settleSpend('int1', 0.3, 'entered');
  A.ok(stamped && stamped.runId === 'int1', 'settleSpend appends the superseding row');
  let row = s.latest('int1');
  A.eq([row.reason, row.usd, row.spendSettled, 'spendUnknown' in row, row.recoveryStatus, row.title, row.ts], ['interrupted', 0.3, 'entered', false, 'needs_review', 'Fix the build', 2000],
    'the served row keeps the run\'s history (reason, status, title, first ts) and carries the settled spend');
  let ins = foldInsights(s.all(), { nowMs: 5000 });
  A.eq([ins.spendUnknownRuns, ins.totalUsd, ins.meteredRuns], [0, 0.55, 2], 'INSIGHTS now counts the settled dollars and no spend-unknown run');
  A.eq(s.count(), 2, 'still one served row per run');
  A.eq(s.settleSpend('int1', 9, 'entered'), null, 'a settled run is not settled twice');
  A.eq(s.settleSpend('done1', 1, 'entered'), null, 'a run whose spend was never unknown is left alone');
  A.eq(s.settleSpend('nope', 1, 'entered'), null, 'an unknown run is a no-op');

  // ---- restart round-trip: a fresh store from the same file ----
  s = makeRunStore({ io: fileIo, clock });
  row = s.latest('int1');
  A.eq([row.usd, row.spendSettled, 'spendUnknown' in row], [0.3, 'entered', false], 'the settlement survives a restart');
  ins = foldInsights(s.all(), { nowMs: 5000 });
  A.eq([ins.spendUnknownRuns, ins.totalUsd], [0, 0.55], 'and INSIGHTS reads it after the restart');

  // ---- a later recovery-status change (the boot scan re-records with spendUnknown:true) never re-opens the spend ----
  clk = 3000;
  s.record({ runId: 'int1', agentId: 'agent', reason: 'interrupted', turns: 3, usd: 0, spendUnknown: true, model: 'm', recoveryStatus: 'resolved', error: 'interrupted: StarNet stopped mid-action; the outcome was reviewed' });
  row = s.latest('int1');
  A.eq([row.recoveryStatus, row.usd, row.spendSettled, 'spendUnknown' in row], ['resolved', 0.3, 'entered', false], 'a status change keeps the settled spend');
  s = makeRunStore({ io: fileIo, clock });
  A.eq(foldInsights(s.all(), { nowMs: 5000 }).spendUnknownRuns, 0, 'and so does the reload after it');

  // ---- counted at its limit ----
  clk = 4000;
  s.record({ runId: 'int2', agentId: 'agent', reason: 'interrupted', usd: 0, spendUnknown: true, model: 'm', recoveryStatus: 'recoverable' });
  s.settleSpend('int2', 0.75, 'limit');
  A.eq([s.latest('int2').usd, s.latest('int2').spendSettled], [0.75, 'limit'], 'a limit settlement says it was counted at the limit, never "entered"');
  A.eq(s.record({ runId: 'r3', reason: 'interrupted', spendUnknown: true, spendSettled: 'guessed' }).spendSettled, undefined, 'only entered/limit are settlements');

  // ---- the ledger names the attested figure (the host heals a row the settle could not restamp, e.g. a row the boot
  // scan wrote AFTER the settle) ----
  const L = makeLedger({ io: { readAll: () => [{ runId: 'prior', agentId: 'agent', usd: 0.5, ts: 1 }], append() {}, unsettled: () => [{ runId: 'int9', agentId: 'agent', ts: 50 }] }, clock });
  A.eq(typeof L.attestedFor, 'function', 'the ledger answers what a settled run was booked at');
  A.eq(L.attestedFor && L.attestedFor('int9'), null, 'nothing before the settle');
  L.settleUnsettled('int9', 1.25, 'entered');
  A.eq(L.attestedFor('int9'), { usd: 1.25, attestedAs: 'entered' }, 'the Commander\'s figure and how it was attested');
  A.eq(L.attestedFor('prior'), null, 'a metered row is not an attestation');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// ---- the host wires it: the settle restamps, the boot scan heals from the ledger ----
{
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const settle = idx.slice(idx.indexOf('async function handleBudgetSettle('), idx.indexOf('async function warmModelCatalogSet('));
  A.ok(settle.length > 200 && settle.length < 6000, 'handleBudgetSettle found');
  const ledgerAt = settle.indexOf('ledger.settleUnsettled(runId, usd'), stampAt = settle.indexOf('runStore.settleSpend(runId, usd');
  A.ok(ledgerAt > 0 && stampAt > ledgerAt, 'the settle restamps the run row after the ledger booked it');
  const sync = A.fnBody(idx, 'function syncInterruptedRunHistory(');
  A.ok(/ledger\.attestedFor\(r\.runId\)/.test(sync), 'the boot scan reads the ledger\'s settlement for the run');
  A.ok(/spendUnknown: !settled/.test(sync) && /spendSettled: settled \? settled\.attestedAs : ''/.test(sync), 'and records a settled run as known spend');
}
A.report('settle-restamps-run');
