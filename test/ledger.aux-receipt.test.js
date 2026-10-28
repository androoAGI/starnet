/* node test/ledger.aux-receipt.test.js — an aux row never settles a run's dispatch receipt (2026-10-27).
   Since every housekeeping call books a row tagged `aux` (ledger.aux-meter.test), some of those rows carry a LIVE run's
   id: hybrid recall embeds the query inside runOnce and books under that runId. ledger.js finishRun treated ANY durable
   row as the run's own booking — it dropped the run's pending receipt in memory and told the host to unlink the
   durable dispatch receipt — so a crash after the embed and before the run's final row read as fully booked on the
   next boot: unknown spend shown as known, the core truthful-telemetry law. A failed aux append likewise marked the
   RUN's booking failed, so an ended unpriced run could no longer be offered for settlement.
   The disk below is the host's contract in memory (sidecar/index.js ledgerIo: dispatch receipts, settlement journals,
   rows; a boot lists a receipt until the run's OWN row is durable). The host's real reader is proved against a real
   sidecar in test/ledger-aux-receipt.http.test.js — requiring index.js here would boot one. */
'use strict';
const A = require('./_assert.js');
const { makeLedger, makeAuxMeter } = require('../sidecar/ledger.js');

const clock = { now: () => 7_000_000 };
let ids = 0;
const nextId = () => 'e-' + (++ids);
function fakeDisk() {
  const disk = { rows: [], receipts: new Map(), journals: new Map(), failAppend: null };
  disk.io = {
    readAll: () => disk.rows.map(r => Object.assign({}, r)),
    unsettled: () => [...disk.receipts.values()].filter(r => !disk.rows.some(e => e.runId === r.runId && !e.aux)).map(r => Object.assign({}, r)),
    beginRun(r) { disk.receipts.set(r.runId, Object.assign({}, r)); },
    append(e) { if (disk.failAppend) throw disk.failAppend; disk.journals.set(e.entryId, Object.assign({}, e)); disk.rows.push(Object.assign({}, e)); },
    finishRun(e) { disk.journals.delete(e.entryId); if (!e.aux) disk.receipts.delete(e.runId); }
  };
  return disk;
}
// a recall embed for a live run, shaped like hybridVectors: one metered call through the aux meter, booked under the run
function embedFor(L, runId, usd) {
  const m = makeAuxMeter({ ledger: L, kind: 'embed' });
  m.add({ prompt_tokens: 12 }, { reconcile: () => ({ usd, tokensIn: 12, tokensOut: 0 }) }, 'text-embed');
  return m.book({ runId, agentId: 'agent', model: 'text-embed', unmetered: false });
}

// ---- the crash: dispatch receipt, a mid-run embed under the run's id, then the process dies before the run books ----
{
  const disk = fakeDisk();
  const L = makeLedger({ io: disk.io, clock, nextId });
  A.eq(L.beginRun('live', 'agent', { provider: 'openrouter', model: 'paid/model' }), true, 'the run writes its dispatch receipt');
  const before = L.pendingRuns();
  const row = embedFor(L, 'live', 0.002);
  A.eq([row.aux, row.runId, disk.rows.length], ['embed', 'live', 1], 'the embed is booked under the live run, tagged aux');
  A.eq(L.pendingRuns(), before, 'an aux row leaves ledger.pendingRuns() unchanged: the run has not booked itself');
  A.ok(disk.receipts.has('live'), 'the durable dispatch receipt survives the aux row');
  A.eq(disk.journals.size, 0, 'the aux row\'s own settlement journal is still cleaned up (io.finishRun ran)');
  A.eq([L.unsettledRuns(), L.health().complete], [[], true], 'a live pending run is not offered for settlement mid-run');
  // crash: no final ledger.record — drop the ledger, keep the disk, boot again
  const boot = makeLedger({ io: disk.io, clock, nextId });
  A.eq(boot.unsettledRuns().map(r => [r.runId, r.agentId, r.provider, r.model]), [['live', 'agent', 'openrouter', 'paid/model']], 'the next boot lists the run as unsettled');
  A.eq([boot.health().complete, boot.health().readError], [false, 'UNSETTLED_SPEND'], 'its spend reads unknown, never as fully booked');
  A.ok(Math.abs(boot.totalUsd() - 0.002) < 1e-12, 'the embed\'s own known charge is kept');
  const settled = boot.settleUnsettled('live', 0.4);
  A.eq([settled.attested, boot.unsettledRuns().length, boot.health().complete, disk.receipts.size], [true, 0, true, 0], 'the Commander can still settle it; that row (not the aux one) clears the receipt');
}

// ---- no crash: the aux row, then the run's own row — the run settles exactly as before ----
{
  const disk = fakeDisk();
  const L = makeLedger({ io: disk.io, clock, nextId });
  L.beginRun('ok', 'agent');
  embedFor(L, 'ok', 0.001);
  L.record({ runId: 'ok', agentId: 'agent', turns: 2, usd: 0.05, tokens: 900 });
  A.eq([L.pendingRuns(), disk.receipts.size, disk.journals.size], [0, 0, 0], 'the run\'s own row settles its receipt');
  const boot = makeLedger({ io: disk.io, clock, nextId });
  A.eq([boot.unsettledRuns(), boot.health().complete, boot.runCount(), boot.count()], [[], true, 1, 2], 'a clean boot: one run, two rows');
}

// ---- an aux row before an unpriced end: the run can still be marked unsettled in this process ----
{
  const disk = fakeDisk();
  const L = makeLedger({ io: disk.io, clock, nextId });
  L.beginRun('unpriced', 'agent');
  embedFor(L, 'unpriced', 0);
  A.eq(L.markUnsettled('unpriced'), true, 'an ended unpriced run still reaches the settlement path after an aux row');
  A.eq(L.unsettledRuns().map(r => r.runId), ['unpriced'], 'and is listed for the Commander');
}

// ---- a FAILED aux append is the aux row's problem, not the run's booking ----
{
  const disk = fakeDisk();
  const L = makeLedger({ io: disk.io, clock, nextId });
  L.beginRun('blip', 'agent');
  disk.failAppend = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  embedFor(L, 'blip', 0.001);
  disk.failAppend = null;
  A.eq([L.health().durable, L.health().writeError], [false, 'ENOSPC'], 'the failed aux write still marks accounting unhealthy');
  A.eq(L.pendingRuns(), 1, 'the run is still pending');
  A.eq(L.markUnsettled('blip'), true, 'the run is not treated as a known-but-unsaved charge: it can still be settled');
}

// ---- a run listed unsettled at boot stays listed when a housekeeping row lands under its id ----
{
  const disk = fakeDisk();
  disk.receipts.set('old', { runId: 'old', agentId: 'agent', ts: 1 });
  const L = makeLedger({ io: disk.io, clock, nextId });
  A.eq(L.unsettledRuns().map(r => r.runId), ['old'], 'boot lists the interrupted run');
  embedFor(L, 'old', 0.001);
  A.eq([L.unsettledRuns().map(r => r.runId), L.health().complete, disk.receipts.has('old')], [['old'], false, true], 'an aux row under its id does not settle it');
}

// ---- after the run's own append FAILED, a post-run pass (reflection) under its id leaves the receipt alone ----
{
  const disk = fakeDisk();
  const L = makeLedger({ io: disk.io, clock, nextId });
  L.beginRun('lost', 'agent');
  disk.failAppend = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  L.record({ runId: 'lost', agentId: 'agent', turns: 1, usd: 0.2, tokens: 100 });
  disk.failAppend = null;
  const m = makeAuxMeter({ ledger: L, kind: 'reflection' });
  m.add({ prompt_tokens: 40, completion_tokens: 8 }, { reconcile: () => ({ usd: 0, tokensIn: 40, tokensOut: 8 }) }, 'sub/model');
  m.book({ runId: 'lost', agentId: 'agent', model: 'sub/model', unmetered: true });
  A.ok(disk.receipts.has('lost'), 'the dispatch receipt (the only durable trace of the unbooked charge) survives the reflection row');
  A.eq([L.pendingRuns(), L.markUnsettled('lost')], [1, false], 'the run stays a known-but-unsaved charge: no manual booking is offered twice');
}

A.report('ledger.aux-receipt.test');
