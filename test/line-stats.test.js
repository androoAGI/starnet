/* node test/line-stats.test.js — LINE WATCH per-line stats fold (sidecar/routing/line-stats.js) + the run-row
   stamp it depends on (runstore records lineId/dockId only when present and well-formed).
   Laws under test: numbers come ONLY from rows stamped with the line; "shipped" is the station SHIPPED predicate
   (clean job + proven work) AND a durable terminal receipt (a job shipped, not a stage done); failed is the dead-run set; a line with no runs answers zeros (never absent, never a guess);
   the $ ledger + cap are read through the injected readers; each bay's LAST outcome is its newest row. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { lineStats, median, shippedRow, failedRow, FAILED_REASONS } = require('../sidecar/routing/line-stats.js');
const { makeLineShipments, cleanShipments, validateShipments, loadShipmentReceipts } = require('../sidecar/routing/line-shipments.js');
const receipt = (lineId, runId, at) => ({ lineId, entryRunId: runId, terminalRunId: runId, outboxId: 'outbox', at });

// ---- median ----
A.eq(median([]), null, 'median of nothing is null (no fabricated time)');
A.eq(median([3000]), 3000, 'median of one');
A.eq(median([4000, 1000, 2000]), 2000, 'median of odd count (unsorted input)');
A.eq(median([1000, 2000, 3000, 4000]), 2500, 'median of even count = mean of the middle two');

// ---- predicates ----
A.ok(shippedRow({ reason: 'done', toolsOk: 1 }), 'done + a successful tool = shipped');
A.ok(shippedRow({ reason: 'done', artifacts: [{ kind: 'file' }] }), 'done + an artifact = shipped');
A.ok(!shippedRow({ reason: 'done', toolsOk: 0, artifacts: [] }), 'done with no proven work is NOT shipped (crate honesty)');
A.ok(!shippedRow({ reason: 'error', toolsOk: 3 }), 'a failed run never ships');
// ONE productive-work predicate (wave 2 review, conveyor-backend-11): line-stats judges a row exactly as the receipt does
{
  const { provenWork } = require('../sidecar/routing/line-shipments.js');
  A.ok(typeof provenWork === 'function', 'line-shipments exports the one productive-work predicate');
  const sample = [{ toolsOk: 1 }, { toolsOk: '2' }, { toolsOk: 0.5 }, { toolsOk: 0 }, { toolsOk: -1 }, { toolsOk: 'x' }, { artifacts: [{ kind: 'file' }] }, { artifacts: [] }, {}, { toolsOk: null, artifacts: 'no' }];
  for (const r of sample) A.eq(shippedRow(Object.assign({ reason: 'done' }, r)), provenWork(r), 'shippedRow and the receipt agree on ' + JSON.stringify(r));
}
for (const r of ['error', 'refusal', 'max_iters', 'budget']) A.ok(failedRow({ reason: r }), r + ' is a failure');
for (const r of ['done', 'cancelled', 'clarifying', 'empty', 'interrupted']) A.ok(!failedRow({ reason: r }), r + ' is not counted as failed');
A.eq(FAILED_REASONS.slice().sort(), ['budget', 'error', 'max_iters', 'refusal'], 'the dead-run set is the slag set');

// ---- the fold ----
const SINCE = 1000;
const rows = [   // NEWEST-FIRST, like runStore.list
  { runId: 'r9', agentId: 'ada', lineId: 'L1', dockId: 'bC', reason: 'error', toolsOk: 0, durationMs: 900, ts: 9000 },
  { runId: 'r8', agentId: 'mira', lineId: 'L1', dockId: 'bB', reason: 'done', toolsOk: 2, durationMs: 3000, ts: 8000 },
  { runId: 'r7', agentId: 'quill', lineId: 'L1', dockId: 'bA', reason: 'done', toolsOk: 0, durationMs: 1000, ts: 7000 },
  { runId: 'r6', agentId: 'zed', lineId: 'L2', dockId: 'bZ', reason: 'refusal', durationMs: 0, ts: 6000 },
  { runId: 'r5', agentId: 'quill', reason: 'done', toolsOk: 4, durationMs: 5000, ts: 5000 },                   // no line: a direct order
  { runId: 'r4', agentId: 'old', lineId: 'GONE', dockId: 'bX', reason: 'done', toolsOk: 1, ts: 4000 },       // a line no longer on the floor
  { runId: 'r3', agentId: 'ada', lineId: 'L1', dockId: 'bC', reason: 'done', toolsOk: 1, durationMs: 2000, ts: 900 },   // BEFORE since
  null, 'garbage', { lineId: 'L1' }                                                                          // unreadable rows are skipped
];
const spend = { L1: 0.0125, L2: 0 };
const caps = { L1: 5, L2: null };
const out = lineStats({ rows, lines: [{ lineId: 'L1' }, { lineId: 'L2' }, { lineId: 'L3' }], since: SINCE,
  spentToday: id => spend[id] || 0, capOf: id => caps[id] == null ? null : caps[id],
  shipments: [receipt('L1', 'r8', 8000)] });   // only r8 has a terminal receipt
const L = id => out.lines.find(l => l.lineId === id);
A.eq(out.since, SINCE, 'answers the window it folded');
A.eq(out.spendDay, 'utc', 'says the $ ledger keeps the UTC day');
A.eq(out.lines.map(l => l.lineId), ['L1', 'L2', 'L3'], 'one entry per plan line, in plan order');
A.eq(L('L1').runs, 3, 'L1: only its stamped rows since the window (the pre-window row is excluded)');
A.eq(L('L1').shipped, 1, 'L1: only the durable terminal-job receipt ships');
A.eq(L('L1').failed, 1, 'L1: the error run is failed');
A.eq(L('L1').medianMs, 1000, 'L1: median of 900/3000/1000');
A.eq(L('L1').usdToday, 0.0125, 'L1: $ today from the ledger reader');
A.eq(L('L1').capUsdPerDay, 5, 'L1: the daily cap from the limits reader');
A.eq(L('L2'), { lineId: 'L2', runs: 1, shipped: 0, failed: 1, tests: 0, medianMs: null, usdToday: 0, capUsdPerDay: null, spendDay: 'utc' }, 'L2: a refusal with no timing -> median null, no cap');
A.eq(L('L3'), { lineId: 'L3', runs: 0, shipped: 0, failed: 0, tests: 0, medianMs: null, usdToday: 0, capUsdPerDay: null, spendDay: 'utc' }, 'L3: a line with no runs answers zeros');
A.ok(!out.lines.some(l => l.lineId === 'GONE'), 'a line no longer on the floor gets no plate');
// SHIPPED = JOBS that reached the OUTBOX (2026-09-24): a 3-stage line finishing one job is 3 done runs but ONE shipment
{
  const job = [
    { runId: 'j3', agentId: 'ed', lineId: 'LJ', dockId: 'd3', reason: 'done', toolsOk: 1, ts: 3003 },
    { runId: 'j2', agentId: 'mid', lineId: 'LJ', dockId: 'd2', reason: 'done', toolsOk: 1, ts: 3002 },
    { runId: 'j1', agentId: 'w', lineId: 'LJ', dockId: 'd1', reason: 'done', toolsOk: 1, ts: 3001 }
  ];
  const one = lineStats({ rows: job, lines: [{ lineId: 'LJ' }], since: 0, shipments: [receipt('LJ', 'j1', 3003)] }).lines[0];
  A.eq([one.runs, one.shipped], [3, 1], 'three done stage runs, ONE job shipped (was: 3 shipped)');
  A.eq(lineStats({ rows: job, lines: [{ lineId: 'LJ' }], shipments: [receipt('LJ', 'j1', 3003), receipt('LJ', 'j1', 3004)] }).lines[0].shipped, 1, 'a duplicate receipt never counts the same job twice');
  A.eq(lineStats({ rows: job, lines: [{ lineId: 'LJ' }], since: 0 }).lines[0].shipped, 0, 'no receipt -> historical run rows never become guessed shipments');
  A.eq(lineStats({ rows: job, lines: [{ lineId: 'LJ' }], since: 0, shipments: [receipt('LJ', 'j1', 3003)], shipsToOutbox: () => { throw new Error('x'); } }).lines[0].shipped, 1, 'later floor edits never rewrite recorded shipments');
}
// the bays' LAST outcome = newest stamped row (any day)
A.eq(out.docks.bC, { runId: 'r9', agentId: 'ada', reason: 'error', failed: true, ts: 9000 }, 'bay C: the newest row (the failure) wins over the older success');
A.eq(out.docks.bA.failed, false, 'bay A: last run done');
A.eq(out.docks.bX.runId, 'r4', 'a bay\'s last outcome is kept even for an old line (the lamp checks the bay is still bound)');
A.ok(!('undefined' in out.docks), 'rows without a dock never key a bay');

// ---- readers that throw degrade to "cannot prove", never to a crash ----
const safe = lineStats({ rows: [], lines: [{ lineId: 'L1' }], since: 0, spentToday: () => { throw new Error('x'); }, capOf: () => { throw new Error('y'); } });
A.eq(safe.lines[0], { lineId: 'L1', runs: 0, shipped: 0, failed: 0, tests: 0, medianMs: null, usdToday: 0, capUsdPerDay: null, spendDay: 'utc' }, 'throwing readers -> zero $ and no cap');
A.eq(lineStats(null).lines, [], 'no input -> no lines');

// ---- STEP TESTS ARE COUNTED APART (conveyor sweep 2026-09-25) ----
// Try-this-step and step-test hops are real runs at real bays (their $ is in the ledger), but they are not JOBS:
// a floor plate that said "10 RUNS · 0 SHIPPED" after ten test clicks claimed work the line never did.
{
  const trows = [
    { runId: 't3', agentId: 'mira', lineId: 'L1', dockId: 'bB', reason: 'done', toolsOk: 2, durationMs: 50, ts: 9500, stepTest: true },
    { runId: 't2', agentId: 'ada', lineId: 'L1', dockId: 'bC', reason: 'error', durationMs: 60, ts: 9400, stepTest: true },
    { runId: 'j1', agentId: 'mira', lineId: 'L1', dockId: 'bB', reason: 'done', toolsOk: 1, durationMs: 4000, ts: 9300 }
  ];
  const t = lineStats({ rows: trows, lines: [{ lineId: 'L1' }], since: SINCE, shipments: [receipt('L1', 'j1', 9300)] }).lines[0];
  A.eq([t.runs, t.shipped, t.failed, t.tests], [1, 1, 0, 2], 'test hops count as TESTS, never as runs / shipped / failed: ' + JSON.stringify(t));
  A.eq(t.medianMs, 4000, 'the median is the real jobs\' time only');
  const LW = require('../frontend/app/linewatch.js');
  A.ok(LW.statsRow(t).some(c => c[0] === 'TESTS' && c[1] === '2'), 'the Workflow panel TODAY row names the tests');
  A.ok(!LW.statsRow(Object.assign({}, t, { tests: 0 })).some(c => c[0] === 'TESTS'), 'and shows no TESTS cell when there were none');
  const st = require('../sidecar/runstore.js').makeRunStore({ io: { readAll: () => [], append: () => {} }, clock: { now: () => 1 } });
  A.eq(st.record({ runId: 's1', reason: 'done', stepTest: true }).stepTest, true, 'the run row records a step-test hop');
  A.ok(!('stepTest' in st.record({ runId: 's2', reason: 'done' })), 'every other row keeps its old shape');
  const src = readSidecarSource();
  A.ok(/stepTest: true\s+\/\/ the run row says it was a TEST hop/.test(src), 'the step-test host stamps its runs stepTest');
  A.ok(/stepTest: o\.stepTest === true, lineId: o\.lineId/.test(src), 'runOnce passes the stamp to the run row');
}

// ---- the run-row stamp (runstore): present only when well-formed ----
const { makeRunStore } = require('../sidecar/runstore.js');
const store = makeRunStore({ io: { readAll: () => [], append: () => {} }, clock: { now: () => 1 } });
if (store && store.record) {
  const a = store.record({ runId: 'x1', agentId: 'quill', reason: 'done', lineId: 'p18', dockId: 'p19' });
  A.eq([a.lineId, a.dockId], ['p18', 'p19'], 'a dispatched run records its line + bay');
  const b = store.record({ runId: 'x2', agentId: 'quill', reason: 'done' });
  A.ok(!('lineId' in b) && !('dockId' in b), 'a run with no line/bay keeps the old row shape');
  const c = store.record({ runId: 'x3', agentId: 'quill', reason: 'done', lineId: '../etc', dockId: '' });
  A.ok(!('lineId' in c) && !('dockId' in c), 'a malformed id is never recorded');
} else {
  A.ok(false, 'runstore exposes makeRunStore().record');
}

// Terminal-job evidence: loop revisits and parallel productive branches still ship once.
{
  let disk = [], writes = 0, clock = 9000, fail = false;
  const base = { streamId: 'channel-1', lineId: 'L1', reason: 'done', toolsOk: 1, ts: 8000, startedAt: 7000 };
  let rows = [
    Object.assign({}, base, { runId: 'last', agentId: 'reviewer', dockId: 'd3' }),
    Object.assign({}, base, { runId: 'branch', agentId: 'branch', dockId: 'd2' }),
    Object.assign({}, base, { runId: 'earlier-pass', agentId: 'reviewer', dockId: 'd3' }),
    Object.assign({}, base, { runId: 'entry', agentId: 'planner', dockId: 'd1' }),
    Object.assign({}, base, { runId: 'previous-job', agentId: 'planner', dockId: 'd1', reason: 'error' })
  ];
  const options = { now: () => clock, load: () => disk,
    save: value => { if (fail) throw new Error('disk full'); disk = JSON.parse(JSON.stringify(value)); writes++; },
    runsFor: () => rows };
  const ledger = makeLineShipments(options);
  const rec = { entryRunId: 'entry', streamId: 'channel-1', lineId: 'L1', agentId: 'reviewer', dockId: 'd3', outboxId: 'o1' };
  A.ok(ledger.record(rec), 'clean productive job at its exact OUTBOX records a shipment');
  A.eq(ledger.snapshot().length, 1, 'four productive runs including a repeated loop bay are one shipped job');
  A.eq(ledger.snapshot()[0].terminalRunId, 'last', 'receipt names the final run at the terminal dock');
  A.ok(ledger.record(rec), 'duplicate callback is idempotent');
  A.eq(writes, 1, 'duplicate does not rewrite persistence');
  A.eq(makeLineShipments(options).snapshot(), ledger.snapshot(), 'receipt survives a fresh ledger load');
  A.eq(lineStats({ rows: [], lines: [{ lineId: 'L1' }], shipments: disk, since: 0 }).lines[0].shipped, 1, 'receipt outlives the run-list query horizon');
  A.eq(lineStats({ lines: [{ lineId: 'L1' }], shipments: disk, since: clock }).lines[0].shipped, 0, 'shipment time obeys the requested window');
  A.eq(cleanShipments([{}, receipt('L1', 'entry', 9000), receipt('L1', 'entry', 9001)]).length, 1, 'malformed and duplicate stored receipts are normalized');
  const changed = Object.assign({}, rec, { entryRunId: 'next', agentId: 'planner', dockId: 'd1' });
  rows.unshift(Object.assign({}, base, { runId: 'next', agentId: 'planner', dockId: 'd1' }));
  A.ok(ledger.record(changed), 'second job with identical timestamps has its own exact entry boundary');
  A.eq(ledger.snapshot().length, 2, 'same-stream adjacent jobs do not collapse');
  A.ok(ledger.record(rec), 'late duplicate cannot borrow later jobs');
  A.eq(ledger.snapshot().length, 2, 'late duplicate stays deduplicated');
  for (const patch of [{ entryRunId: 'missing' }, { outboxId: null }, { streamId: null }, { dockId: 'missing', entryRunId: 'branch' }]) {
    A.ok(!ledger.record(Object.assign({}, rec, patch)), 'unknown shipment evidence is refused: ' + JSON.stringify(patch));
  }
  for (const patch of [{ reason: 'error' }, { reason: 'budget' }, { reason: 'max_iters' }, { stepTest: true }, { toolsOk: 0, artifacts: [] }]) {
    rows = [Object.assign({}, base, patch, { runId: 'fresh', agentId: 'reviewer', dockId: 'd3' })];
    A.ok(!ledger.record(Object.assign({}, rec, { entryRunId: 'fresh' })), 'unclean/test/workless run cannot mint a shipment: ' + JSON.stringify(patch));
  }
  rows = [Object.assign({}, base, { runId: 'fresh', agentId: 'reviewer', dockId: 'd3', toolsOk: 0, artifacts: [{ kind: 'file' }] })];
  fail = true;
  A.ok(!ledger.record(Object.assign({}, rec, { entryRunId: 'fresh' })), 'failed durable save refuses the count');
  A.eq(ledger.snapshot().length, 2, 'failed save does not publish an in-memory shipment');
  // (runtime repair 2026-10-12) …it is held instead of dropped, and while it waits SHIPPED reads as a lower bound
  A.ok(ledger.held() === 1 && ledger.missedAt() === clock, 'the unsaved receipt is held and marks the count a lower bound (missedAt ' + ledger.missedAt() + ')');
  A.ok(lineStats({ lines: [{ lineId: 'L1' }], shipments: ledger.snapshot(), since: 0, shipmentsMissedAt: ledger.missedAt() }).lines[0].shippedAtLeast === true, '…which line-stats reports as N+');
  fail = false;
  A.ok(ledger.record(Object.assign({}, rec, { entryRunId: 'fresh' })), 'retry can record a proven artifact after storage recovers');
  A.ok(ledger.held() === 0 && ledger.missedAt() === null && ledger.snapshot().length === 3, 'the held receipt is written once, and the count is exact again');
}
// The host must preserve domain-store provenance instead of reading .value alone.
{
  for (const status of ['ok', 'recovered', 'absent']) {
    A.eq(loadShipmentReceipts({ load: () => ({ status, value: [] }) }), [], status + ' receipt store may be read');
  }
  for (const status of ['unreadable', 'corrupt', 'invalid', 'unknown']) {
    let failed = false;
    try { loadShipmentReceipts({ load: () => ({ status, value: [] }) }); } catch (_) { failed = true; }
    A.ok(failed, status + ' default value must never be mistaken for a new empty history');
  }
}
// A temporarily unreadable store is not an empty history. A failed first stats
// poll must leave loading retryable, and no later save may replace old receipts.
{
  const original = receipt('L1', 'old', 100);
  let disk = [original], blocked = true, writes = 0;
  const fresh = { lineId: 'L1', entryRunId: 'new', streamId: 's', agentId: 'a', dockId: 'd', outboxId: 'o' };
  const ledger = makeLineShipments({
    now: () => 200,
    load: () => { if (blocked) throw new Error('locked'); return disk; },
    save: value => { writes++; disk = JSON.parse(JSON.stringify(value)); },
    runsFor: () => [{ runId: 'new', lineId: 'L1', streamId: 's', agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }]
  });
  let failed = false; try { ledger.snapshot(); } catch (_) { failed = true; }
  A.ok(failed, 'first failed stats read does not assert an empty shipment history');
  A.ok(!ledger.record(fresh), 'unreadable prior history refuses receipt writes');
  A.eq(writes, 0, 'no write occurs while the load authority is unavailable');
  blocked = false;
  // (runtime repair 2026-10-12) the job that shipped while the history was unreadable is HELD, no longer dropped: the first read
  // after recovery restores the old receipt exactly and writes the held one beside it
  A.eq(ledger.snapshot(), [original, { lineId: 'L1', entryRunId: 'new', terminalRunId: 'new', outboxId: 'o', at: 200 }], 'next stats read retries, recovers the previous receipt and writes the held one');
  A.eq(writes, 1, 'one write, only after the history read valid');
  A.ok(ledger.record(fresh), 'after recovery a real new receipt may be saved');
  A.eq(disk.map(r => r.entryRunId), ['old', 'new'], 'recovered history and new shipment both survive');
}
// A durable write can succeed before its read-back fails. Reload before B.
{
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { makeDomainStore } = require('../sidecar/domain-store.js');
  const { writeFileDurable } = require('../sidecar/durable-write.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shipment-readback-'));
  const file = path.join(dir, 'line-shipments.json');
  let blocked = false, failReadback = false, writes = 0;
  const faultFs = Object.create(fs);
  faultFs.readFileSync = (target, ...args) => {
    if (target === file && blocked) throw Object.assign(new Error('read-back locked'), { code: 'EACCES' });
    return fs.readFileSync(target, ...args);
  };
  const domain = makeDomainStore({ fs: faultFs, path, file, version: 1, defaults: () => [], normalize: validateShipments,
    decode: envelope => envelope && Array.isArray(envelope.value) ? envelope.value : undefined,
    writeDurable: (deps, target, data) => {
      writeFileDurable(deps, target, data);
      if (target === file) { writes++; if (failReadback) { failReadback = false; blocked = true; } }
    }
  });
  const rec = runId => ({ lineId: 'L1', entryRunId: runId, streamId: runId, agentId: 'a', dockId: 'd', outboxId: 'o' });
  const options = { now: () => 300, load: () => loadShipmentReceipts(domain), save: value => domain.save(value),
    runsFor: runId => [{ runId, lineId: 'L1', streamId: runId, agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }] };
  try {
    const ledger = makeLineShipments(options);
    A.eq(ledger.snapshot(), [], 'absent receipt file starts empty');
    failReadback = true;
    A.ok(!ledger.record(rec('A')), 'post-commit read-back error does not claim save success');
    A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).value.map(r => r.entryRunId), ['A'], 'A reached durable main before read-back failed');
    A.throws(() => ledger.snapshot(), 'ambiguous save invalidates cache; unreadable authority is not stale zero');
    A.ok(!ledger.record(rec('B')), 'B refuses while committed authority remains unreadable');
    A.eq(writes, 1, 'no write while authoritative reload is blocked');
    blocked = false;
    A.ok(ledger.record(rec('B')), 'B records after committed main becomes readable');
    A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).value.map(r => r.entryRunId), ['A', 'B'], 'B appends to durable A instead of the pre-save cache');
    A.eq(makeLineShipments(options).snapshot().map(r => r.entryRunId), ['A', 'B'], 'both receipts survive a restarted ledger');
    A.ok(ledger.record(rec('A')), 'callback retry recognizes committed A');
    A.eq(writes, 2, 'retry of A does not write a duplicate');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Persisted identities are exact; malformed evidence cannot be silently dropped.
{
  const original = receipt('L1', 'entry', 100);
  A.eq(validateShipments([original, Object.assign({}, original)]), [original], 'identical receipt copies count once');
  A.eq(validateShipments([original, Object.assign({}, original, { lineId: 'L2' })]).length, 2, 'same entry identity on distinct lines remains distinct');
  for (const patch of [
    { lineId: '../line' }, { lineId: 'L'.repeat(81) }, { outboxId: 'o/1' },
    { entryRunId: 42 }, { entryRunId: '' }, { entryRunId: '   ' }, { entryRunId: 'r\n1' },
    { terminalRunId: null }, { terminalRunId: 'r'.repeat(257) }, { at: '100' }, { at: -1 }, { at: Infinity }
  ]) A.throws(() => validateShipments([Object.assign({}, original, patch)]), 'reject invalid stored fields: ' + JSON.stringify(patch));
  for (const patch of [{ terminalRunId: 'other' }, { outboxId: 'other' }, { at: 101 }]) {
    A.throws(() => validateShipments([original, Object.assign({}, original, patch)]), 'conflicting duplicate job receipt is unavailable: ' + JSON.stringify(patch));
  }
  A.throws(() => loadShipmentReceipts({ load: () => ({ status: 'ok', value: [null] }) }), 'successful storage status cannot authorize an invalid receipt row');
}
// Exercise the actual host store initializer, including its diagnostic handler.
// Repeated polls and a productive callback must not rename, repair or overwrite
// corrupt/invalid authority, and restoration must recover without a restart.
{
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { makeDomainStore } = require('../sidecar/domain-store.js');
  const { writeFileDurable } = require('../sidecar/durable-write.js');
  const source = readSidecarSource();
  const start = source.indexOf('const lineShipmentStore = makeDomainStore(');
  const end = source.indexOf('const lineShipments = makeLineShipments(', start);
  const initializer = source.slice(start, end);
  A.ok(start >= 0 && end > start && initializer.length < 1800, 'bounded actual host receipt-store initializer is available');
  const makeHostStore = new Function('makeDomainStore', 'fs', 'path', 'WORKSPACES', 'writeFileDurable', 'validateShipments', 'console', initializer + '\nreturn lineShipmentStore;');
  const original = receipt('L1', 'old', 100);
  const samples = [
    ['invalid row', JSON.stringify({ version: 1, value: [original, {}] })],
    ['invalid identity', JSON.stringify({ version: 1, value: [Object.assign({}, original, { entryRunId: 42 })] })],
    ['conflicting duplicate', JSON.stringify({ version: 1, value: [original, Object.assign({}, original, { outboxId: 'other' })] })],
    ['corrupt main without backup', '{"version":1,"value":'],
    ['empty main without backup', '']
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shipment-invalid-'));
  try {
    samples.forEach(([name, bytes], i) => {
      const dir = path.join(root, String(i)); fs.mkdirSync(dir);
      const file = path.join(dir, 'line-shipments.json'); fs.writeFileSync(file, bytes);
      let writes = 0;
      const domain = makeHostStore(makeDomainStore, fs, path, dir, (deps, target, data) => { writes++; writeFileDurable(deps, target, data); }, validateShipments, { warn: () => {} });
      let saves = 0;
      const ledger = makeLineShipments({ now: () => 200, load: () => loadShipmentReceipts(domain), save: value => { saves++; domain.save(value); },
        runsFor: () => [{ runId: 'new', lineId: 'L1', streamId: 's', agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }] });
      const rec = { lineId: 'L1', entryRunId: 'new', streamId: 's', agentId: 'a', dockId: 'd', outboxId: 'o' };
      A.throws(() => ledger.snapshot(), name + ': first poll is unavailable');
      A.throws(() => ledger.snapshot(), name + ': second poll stays unavailable');
      A.ok(!ledger.record(rec), name + ': productive callback cannot replace unknown history');
      A.eq(writes, 0, name + ': no attempted save');
      A.eq(fs.readFileSync(file, 'utf8'), bytes, name + ': forensic bytes remain at the authoritative path');
      fs.writeFileSync(file, JSON.stringify({ version: 1, value: [original, Object.assign({}, original)] }));
      // (runtime repair 2026-10-12) the productive job refused above is HELD, no longer dropped: written once the history reads valid
      A.eq(ledger.snapshot(), [original, { lineId: 'L1', entryRunId: 'new', terminalRunId: 'new', outboxId: 'o', at: 200 }], name + ': restoring valid duplicate copies recovers one exact old receipt, then writes the job held while it was unreadable');
      A.eq(saves, 1, name + ': one save, only after the restored history read valid');
      A.ok(ledger.record(rec), name + ': restored authority accepts the next real shipment');
      A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).value.map(r => r.entryRunId), ['old', 'new'], name + ': next save retains old history exactly once');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
// Actual PARALLEL CREW switched to COPY/JOINER: three productive branches,
// one terminal job. Removing the OUTBOX cannot alter its historical receipt.
{
  const WM = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js');
  const { makeRouter } = require('../sidecar/routing/router.js');
  const doc = WM.starterDoc();
  for (const room of Object.values(doc.rooms)) for (const rect of room.rects) { rect.x2 = 55; rect.y2 = 35; }
  const station = WM.create(doc), placed = station.stampBlueprint('parallel_crew', 10, 10);
  A.ok(placed.ok, 'parallel blueprint stamps for shipment proof');
  station.props().filter(p => p.t === 'bay').forEach((p, i) => station.assignPropAgent(p.id, 'a' + i));
  A.ok(station.swapJoinerMerger(station.props().find(p => p.t === 'merger').id).ok, 'branches meet at JOINER');
  const router = makeRouter(), plan = P.compileRoutingPlan(station.projectGeometry());
  A.ok(router.setPlan(plan).ok, 'joined floor deploys');
  const bays = station.props().filter(p => p.t === 'bay'), lineId = plan.lineOfProp[bays[0].id];
  const rows = bays.map((p, i) => ({ runId: 'branch-' + i, lineId, dockId: p.id, agentId: p.agentId, reason: 'done', toolsOk: 1, ts: 100 + i }));
  A.ok(rows.every(r => router.chainShipsToOutbox(r.agentId, r.dockId)), 'old topology predicate incorrectly qualified every branch');
  const done = Object.assign(receipt(lineId, 'branch-0', 104), { outboxId: station.props().find(p => p.t === 'outbox').id });
  const input = { rows, lines: plan.lines, since: 0, shipments: [done], shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d) };
  A.eq(lineStats(input).lines.find(l => l.lineId === lineId).shipped, 1, 'three joined branch runs ship one job');
  station.removeProp(done.outboxId);
  router.setPlan(P.compileRoutingPlan(station.projectGeometry()));
  A.ok(rows.every(r => !router.chainShipsToOutbox(r.agentId, r.dockId)), 'edited topology no longer reaches OUTBOX');
  A.eq(lineStats(input).lines.find(l => l.lineId === lineId).shipped, 1, 'floor edit cannot erase the real past shipment');
}
const asyncChecks = [];   // the world.js poll check is async: A.report waits for it
// SHIPPED UNKNOWN (runtime audit 2026-10-12): an unreadable shipment history makes SHIPPED unknown on every line — null with the
// reason, never 0 — and every other number keeps counting. Absent shipments WITHOUT that flag still answer 0 (no receipts yet).
{
  const rows = [{ runId: 'u1', lineId: 'L1', dockId: 'd1', agentId: 'a', reason: 'done', toolsOk: 1, ts: 50, durationMs: 1000 },
    { runId: 'u2', lineId: 'L1', dockId: 'd2', agentId: 'b', reason: 'error', ts: 40, durationMs: 3000 }];
  const why = 'shipment history unreadable: shipment history could not be read (invalid)';
  const st = lineStats({ rows, lines: [{ lineId: 'L1' }, { lineId: 'L2' }], since: 0, spentToday: () => 0.25, capOf: () => 1, shipments: [receipt('L1', 'u1', 60)], shippedUnknown: why });
  const L1 = st.lines.find(l => l.lineId === 'L1'), L2 = st.lines.find(l => l.lineId === 'L2');
  A.ok(L1.shipped === null && L2.shipped === null, 'SHIPPED is null on every line while the history is unreadable');
  A.ok(st.shippedUnknown === why && L1.shippedUnknown === why && L2.shippedUnknown === why, 'the answer and each line carry the reason');
  A.eq([L1.runs, L1.failed, L1.medianMs, L1.usdToday, L1.capUsdPerDay], [2, 1, 2000, 0.25, 1], 'runs, failed, median, $ today and the cap still count');
  A.ok(st.docks.d1 && st.docks.d2 && st.docks.d2.failed === true, 'the bay lamps keep their last outcomes');
  const known = lineStats({ rows, lines: [{ lineId: 'L1' }], since: 0, shipments: [receipt('L1', 'u1', 60)] });
  A.ok(known.lines[0].shipped === 1 && !('shippedUnknown' in known) && !('shippedUnknown' in known.lines[0]), 'a readable history answers a number and no reason');
  A.eq(lineStats({ rows, lines: [{ lineId: 'L1' }], since: 0 }).lines[0].shipped, 0, 'no shipments and no flag is still 0 — no receipts yet');
  // the page never turns unknown into a number
  const LWu = require('../frontend/app/linewatch.js');
  const plate = LWu.plateLines(L1), row = LWu.statsRow(L1);
  A.ok(/^2 RUNS · \? SHIPPED · 1 FAILED$/.test(plate[0]), 'the INBOX plate reads ? SHIPPED: ' + plate[0]);
  A.ok(/SHIPMENT HISTORY UNREADABLE/.test(plate[2]) && !/SHIPMENT HISTORY UNREADABLE/.test(LWu.plateLines(known.lines[0])[2]), 'the hover glance names why, only while it is unknown: ' + plate[2]);
  A.eq(row.find(c => c[0] === 'SHIPPED'), ['SHIPPED', '?'], 'the Workflow panel TODAY row reads ?');
  A.eq(LWu.statsRow(known.lines[0]).find(c => c[0] === 'SHIPPED'), ['SHIPPED', '1'], 'and a number when it is known');
  // world.js: an HTTP failure clears the floor's numbers (a network drop keeps them, dimmed as last-known); an unknown SHIPPED
  // holds the OUTBOX pallet instead of drawing a count
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
  const poll = world.slice(world.indexOf('  function pollLineStats() {'), world.indexOf('  function lineStatsSoon() {'));
  const pallet = world.slice(world.indexOf('  function drawShippedPallet(now) {'), world.indexOf('  function drawPallet('));
  // the poll also re-reads FIRST SHIP's per-line counts when the posted floor has a line with none (agent lane: shipBaseStale /
  // refreshShipBase) — the real ship-base functions ride the slice, over the same stubbed fetch
  const shipBaseSrc = world.slice(world.indexOf('  const firstShipSeen = new Set();'), world.indexOf('  function noteFirstShip(p) {'));
  A.ok(poll.length > 100 && pallet.length > 100, 'the real world.js poll and pallet functions are loaded');
  A.ok(shipBaseSrc.length > 100 && shipBaseSrc.length < 6000 && /function shipBaseStale\(\)/.test(shipBaseSrc) && /function refreshShipBase\(\)/.test(shipBaseSrc), 'the real world.js ship-base readers are loaded');
  const runPoll = async (response) => {
    const ctx = vm.createContext({ LineWatch: LWu, apiUrl: u => u, pollLineJobStreams: () => {}, buildRoutingNags: () => ['nags'], routingNags: null, routingPlan: null,
      lineWatch: () => ({ seedOutcomes: () => {} }), lineStats: { known: true, byLine: { L1: { runs: 9, shipped: 4 } }, since: 1 },
      fetch: () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)), Date });
    vm.runInContext(shipBaseSrc + poll + '\nglobalThis.go = pollLineStats; globalThis.read = () => lineStats;', ctx);
    ctx.go(); for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    return ctx.read();
  };
  asyncChecks.push((async () => {
    const after500 = await runPoll({ ok: false, status: 500, json: async () => ({ ok: false }) });
    A.ok(after500.known === false && Object.keys(after500.byLine).length === 0, 'a 500 never leaves the last numbers standing: ' + JSON.stringify(after500));
    const afterDrop = await runPoll(new Error('offline'));
    A.ok(afterDrop.known === true && afterDrop.byLine.L1.runs === 9, 'a network drop keeps the last server answer (the link-down dim marks it last-known)');
    const fresh = await runPoll({ ok: true, json: async () => ({ ok: true, lines: [{ lineId: 'L1', runs: 2, shipped: null, shippedUnknown: why }], docks: {} }) });
    A.ok(fresh.known === true && fresh.byLine.L1.shipped === null, 'an unknown SHIPPED is kept as unknown');
    const drawn = [];
    const pctx = vm.createContext({ lineStats: { known: true, byLine: { L1: { runs: 2, shipped: null }, L2: { runs: 1, shipped: 3 } } },
      routingPlan: { lineOfProp: { o1: 'L1', o2: 'L2' } }, geo: { props: [{ id: 'o1', t: 'outbox', x: 0, y: 0 }, { id: 'o2', t: 'outbox', x: 5, y: 0 }] },
      palletSeen: new Map(), drawPallet: (ob, done) => drawn.push(ob.id + ':' + done) });
    vm.runInContext(pallet + '\nglobalThis.draw = drawShippedPallet;', pctx);
    pctx.draw(1000);
    A.eq(drawn, ['o2:3'], 'an unknown SHIPPED draws no pallet count (never a 0, never the stale one); a known line still does');
  })().catch(e => A.ok(false, 'world.js poll/pallet check threw: ' + (e && e.stack || e))));
}
// BOUNDED HISTORY (runtime audit 2026-10-12): every shipment rewrote and re-validated the WHOLE history synchronously inside
// chain.advance, and nothing pruned it — 50 000 receipts blocked a job's hand-back 0.4–2 s. Receipts older than the retention
// window are dropped on the next save; today's SHIPPED is unchanged (it only counts receipts since local midnight).
{
  const { SHIPMENT_KEEP_MS } = require('../sidecar/routing/line-shipments.js');
  A.ok(typeof SHIPMENT_KEEP_MS === 'number' && SHIPMENT_KEEP_MS >= 2 * 24 * 60 * 60 * 1000, 'the retention window is exported and covers any local midnight');
  const DAY = 24 * 60 * 60 * 1000, now = 100 * DAY, midnight = now - 6 * 60 * 60 * 1000;
  const old = [];
  for (let i = 0; i < 500; i++) old.push(receipt('L1', 'old-' + i, now - SHIPMENT_KEEP_MS - DAY - i));
  const today = [receipt('L1', 'today-1', midnight + 1000), receipt('L1', 'today-2', midnight + 2000)];
  let disk = old.concat(today), writes = 0;
  const before = lineStats({ lines: [{ lineId: 'L1' }], shipments: disk, since: midnight }).lines[0].shipped;
  const ledger = makeLineShipments({ now: () => now, load: () => disk, save: v => { writes++; disk = JSON.parse(JSON.stringify(v)); },
    runsFor: () => [{ runId: 'job-3', lineId: 'L1', streamId: 's', agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }] });
  A.ok(ledger.record({ lineId: 'L1', entryRunId: 'job-3', streamId: 's', agentId: 'a', dockId: 'd', outboxId: 'o' }), 'a new job records');
  A.eq(writes, 1, 'one write');
  A.eq(disk.map(r => r.entryRunId), ['today-1', 'today-2', 'job-3'], 'the saved history drops every receipt past the retention window');
  A.eq(lineStats({ lines: [{ lineId: 'L1' }], shipments: disk, since: midnight }).lines[0].shipped, before + 1, 'today\'s SHIPPED is unchanged by the prune (+ the new job)');
  A.eq(ledger.snapshot().length, 3, 'the cache matches what was saved');
}
/* BOUNDED BY COUNT TOO (runtime repair 2026-10-12): an age window alone still let a busy line keep ~50 000 receipts in it, every one
   re-validated and rewritten per job. A save keeps at most the newest SHIPMENT_KEEP_MAX; when that cap bound inside a stats window,
   SHIPPED there is a LOWER BOUND (shippedAtLeast, N+ on the page) — never a count that quietly lost jobs. */
{
  const { SHIPMENT_KEEP_MS, SHIPMENT_KEEP_MAX } = require('../sidecar/routing/line-shipments.js');
  A.ok(SHIPMENT_KEEP_MS <= 2 * 24 * 60 * 60 * 1000 && SHIPMENT_KEEP_MAX > 0 && SHIPMENT_KEEP_MAX <= 5000, 'the history is bounded by age (48 h) AND by count (' + SHIPMENT_KEEP_MAX + ')');
  const DAY = 24 * 60 * 60 * 1000, midnight = 200 * DAY;
  let now = midnight + 60 * 1000;
  // a high-volume day: the history already holds the cap, every receipt from today
  let disk = [];
  for (let i = 0; i < SHIPMENT_KEEP_MAX; i++) disk.push(receipt('L1', 'busy-' + i, midnight + 1000 + i));
  let writes = 0, biggest = 0;
  const ledger = makeLineShipments({ now: () => now, load: () => disk, save: v => { writes++; disk = v.slice(); biggest = Math.max(biggest, disk.length); },
    runsFor: sid => [{ runId: sid, lineId: 'L1', streamId: sid, agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }] });
  for (let i = 0; i < 40; i++) { now += 10; A.ok(ledger.record({ lineId: 'L1', entryRunId: 'more-' + i, streamId: 'more-' + i, agentId: 'a', dockId: 'd', outboxId: 'o' }), i ? null : 'more jobs record past the cap'); }
  A.eq(writes, 40, 'one write per job');
  A.ok(biggest === SHIPMENT_KEEP_MAX && disk.length === SHIPMENT_KEEP_MAX, 'the saved history never holds more than the cap (' + biggest + ')');
  A.ok(disk.every(r => r.entryRunId !== 'busy-0' && r.entryRunId !== 'busy-39') && disk.some(r => r.entryRunId === 'busy-40') && disk[disk.length - 1].entryRunId === 'more-39', 'the OLDEST receipts are the ones dropped');
  A.ok(JSON.stringify(disk).length < 200 * SHIPMENT_KEEP_MAX, 'so the file stays bounded: ' + JSON.stringify(disk).length + ' bytes');
  const capped = lineStats({ lines: [{ lineId: 'L1' }, { lineId: 'L2' }], shipments: ledger.snapshot(), since: midnight });
  A.ok(capped.lines[0].shipped === SHIPMENT_KEEP_MAX && capped.lines[0].shippedAtLeast === true && capped.shippedAtLeast === true && capped.lines[1].shippedAtLeast === true,
    'a window the cap cut into answers a LOWER BOUND, on every line (which line lost a job is not known): ' + JSON.stringify(capped.lines[0]));
  const inside = lineStats({ lines: [{ lineId: 'L1' }], shipments: disk, since: disk[0].at });
  A.ok(!('shippedAtLeast' in inside.lines[0]) && !('shippedAtLeast' in inside), 'a window that starts after everything the cap dropped is exact');
  const LWa = require('../frontend/app/linewatch.js');
  A.ok(/ 5000\+ SHIPPED /.test(LWa.plateLines(capped.lines[0])[0].replace(/^/, ' ').replace(/ · /g, '  ')) || / 5000\+ SHIPPED/.test(' ' + LWa.plateLines(capped.lines[0])[0]), 'the plate reads N+ SHIPPED: ' + LWa.plateLines(capped.lines[0])[0]);
  A.eq(LWa.statsRow(capped.lines[0]).find(c => c[0] === 'SHIPPED'), ['SHIPPED', SHIPMENT_KEEP_MAX + '+'], 'and the TODAY row N+');
}
/* HELD, NOT DROPPED (runtime repair 2026-10-12): a productive job that shipped while the history could not be read was refused for
   good, so once the file was readable again SHIPPED showed a definite number that left it out. Its receipt is held and written by
   the first snapshot()/record() after a validated read — never over the unreadable bytes. */
{
  const DAY = 24 * 60 * 60 * 1000, midnight = 300 * DAY, now = midnight + 5000;
  let disk = [receipt('L1', 'before', midnight + 10)], broken = true, writes = 0;
  const runs = sid => [{ runId: sid, lineId: 'L1', streamId: sid, agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }];
  const ledger = makeLineShipments({ now: () => now, load: () => { if (broken) throw new Error('shipment history could not be read (corrupt)'); return disk; },
    save: v => { if (broken) throw new Error('never written over unreadable bytes'); writes++; disk = v.slice(); }, runsFor: runs });
  const job = id => ({ lineId: 'L1', entryRunId: id, streamId: id, agentId: 'a', dockId: 'd', outboxId: 'o' });
  A.eq(ledger.record(job('during-1')), false, 'a job that ships while the history is unreadable is not persisted (false)');
  A.eq(ledger.record(job('during-1')), false, '…the same job again holds once');
  A.eq([ledger.held(), writes], [1, 0], 'its receipt is held, nothing was written');
  A.ok((() => { try { ledger.snapshot(); return false; } catch (_) { return true; } })(), 'SHIPPED stays unknown while the history is unreadable');
  broken = false;   // the user restores the file
  const snap = ledger.snapshot();
  A.eq([snap.map(r => r.entryRunId), ledger.held(), writes], [['before', 'during-1'], 0, 1], 'the first read after it is readable writes the held receipt');
  A.eq(lineStats({ lines: [{ lineId: 'L1' }], shipments: snap, since: midnight }).lines[0].shipped, 2, 'SHIPPED counts the job that shipped while it was unreadable');
  // held + a new job: one write carries both
  broken = true; ledger.record(job('during-2'));
  const r2 = (() => { broken = false; return ledger.record(job('after-1')); })();
  A.ok(r2 && disk.map(r => r.entryRunId).join() === 'before,during-1,during-2,after-1' && ledger.held() === 0, 'a record() after recovery writes what was held first: ' + disk.map(r => r.entryRunId).join());
  // past the hold bound: the jobs are not counted, and SHIPPED says it is a lower bound from then on
  broken = true;
  for (let i = 0; i < 520; i++) ledger.record(job('flood-' + i));
  A.ok(ledger.held() === 500 && ledger.missedAt() === now, 'the hold is bounded (500) and remembers when a job went uncounted');
  broken = false;
  const flood = lineStats({ lines: [{ lineId: 'L1' }], shipments: ledger.snapshot(), since: midnight, shipmentsMissedAt: ledger.missedAt() });
  A.ok(flood.lines[0].shipped === 504 && flood.lines[0].shippedAtLeast === true, 'what was held counts, and SHIPPED is a lower bound: ' + JSON.stringify(flood.lines[0]));
  A.ok(!('shippedAtLeast' in lineStats({ lines: [{ lineId: 'L1' }], shipments: disk, since: now, shipmentsMissedAt: ledger.missedAt() }).lines[0]), 'a window that starts after the missed job is exact');
}
/* A PARTIAL JOINED JOB IS NOT A SHIPMENT (runtime repair 2026-10-12): a COPY branch the host refused before it ran writes no run row,
   so every row that exists ended done — the chain's own mark (rec.partial) is what refuses it */
{
  let disk = [], writes = 0;
  const ledger = makeLineShipments({ now: () => 5000, load: () => disk, save: v => { writes++; disk = v.slice(); },
    runsFor: sid => [{ runId: sid, lineId: 'L1', streamId: sid, agentId: 'a', dockId: 'd', reason: 'done', toolsOk: 1 }] });
  A.eq(ledger.record({ lineId: 'L1', entryRunId: 'pj', streamId: 'pj', agentId: 'a', dockId: 'd', outboxId: 'o', partial: 'crew0 failed' }), false, 'a partial joined job records no receipt');
  A.eq([writes, disk.length], [0, 0], 'nothing is written');
  A.ok(ledger.record({ lineId: 'L1', entryRunId: 'ok', streamId: 'ok', agentId: 'a', dockId: 'd', outboxId: 'o' }), 'the same job whole records');
}
/* DID THIS JOB COUNT IN SHIPPED? (rc walk #30: the panel said ✓ DELIVERED beside SHIPPED 0) — the job's own answer comes from the
   very receipts SHIPPED counts: a productive job true, a text-only job false, an unreadable history null (unknown, never false),
   and a receipt held while the history is unreadable true (it is counted once the history reads again) */
{
  let disk = [], broken = false;
  const runs = { prod: { toolsOk: 1 }, talk: { toolsOk: 0, artifacts: [] }, held: { toolsOk: 2 } };
  const ledger = makeLineShipments({ now: () => 7000, load: () => { if (broken) throw new Error('locked'); return disk; }, save: v => { disk = v.slice(); },
    runsFor: sid => [Object.assign({ runId: sid, lineId: 'L1', streamId: sid, agentId: 'a', dockId: 'd', reason: 'done' }, runs[sid])] });
  const job = id => ({ lineId: 'L1', entryRunId: id, streamId: id, agentId: 'a', dockId: 'd', outboxId: 'o' });
  A.ok(ledger.record(job('prod')) && !ledger.record(job('talk')), 'a productive job ships; a text-only job is delivered but mints no receipt');
  A.eq(ledger.jobShipped('L1', ['later-hop', 'prod']), true, 'the productive job counted in SHIPPED (any of its run ids may be the entry)');
  A.eq(ledger.jobShipped('L1', ['talk']), false, 'the text-only job did not — the panel says so beside DELIVERED');
  A.eq(ledger.jobShipped('L2', ['prod']), false, 'a receipt on another line is not this job\'s');
  A.eq([ledger.jobShipped('', ['prod']), ledger.jobShipped('L1', [])], [null, null], 'no line or no runs: unknown, never a guess');
  broken = true;
  const fresh = makeLineShipments({ now: () => 7000, load: () => { if (broken) throw new Error('locked'); return disk; }, save: v => { disk = v.slice(); },
    runsFor: sid => [Object.assign({ runId: sid, lineId: 'L1', streamId: sid, agentId: 'a', dockId: 'd', reason: 'done' }, runs[sid])] });
  A.eq(fresh.jobShipped('L1', ['prod']), null, 'an unreadable history answers unknown (null), never "not shipped"');
  fresh.record(job('held'));
  A.eq(fresh.jobShipped('L1', ['held']), true, 'a receipt held while the history is unreadable counts (it is written once the history reads)');
  broken = false;
}
Promise.all(asyncChecks).then(() => A.report());
