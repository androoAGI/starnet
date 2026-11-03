/* node test/ledger.test.js — the append-only spend ledger, fed an in-memory io + a controllable clock
   (zero disk). Asserts: record stamps ts + persists, totals/day-window/per-run/per-agent queries, a
   prior log is loaded on construction, and corrupt io degrades to empty (never throws into a run). */
'use strict';
const A = require('./_assert.js');
const { makeLedger } = require('../sidecar/ledger.js');

// a fake io with an inspectable backing array + a clock we step by hand
function fakeIo(seed) { const rows = (seed || []).slice(); return { rows, readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }
let t = 1_000_000;
const clock = { now: () => t };

// ---- record stamps ts, persists through io, returns the entry ----
{
  const io = fakeIo();
  const L = makeLedger({ io, clock });
  const e = L.record({ runId: 'r1', agentId: 'a', turns: 3, usd: 0.5, tokens: 1200 });
  A.eq(e.ts, t, 'record stamps the injected clock time');
  A.eq(e.usd, 0.5, 'usd preserved');
  A.eq(e.model, '(unknown)', 'missing model records explicit unknown');
  A.eq(e.unmetered, false, 'metered by default');
  A.eq(io.rows.length, 1, 'entry persisted through io.append');
  A.eq(L.count(), 1, 'count reflects the recorded run');
  A.eq(io.rows[0].runId, 'r1', 'persisted entry carries the runId');
}

// ---- an explicit ts wins over the clock; missing/garbage fields coerce to safe zeros/strings ----
{
  const L = makeLedger({ io: fakeIo(), clock });
  A.eq(L.record({ runId: 'r', usd: 1, ts: 42 }).ts, 42, 'explicit ts is honored');
  const z = L.record({});
  A.eq([z.runId, z.agentId, z.turns, z.usd, z.tokens], ['', '', 0, 0, 0], 'absent fields coerce to safe defaults');
  A.eq(z.model, '(unknown)', 'absent model coerces to explicit unknown');
  A.eq(z.ts, t, 'absent ts falls back to the clock');
}

// ---- model + unmetered are persisted on spend rows ----
{
  const io = fakeIo();
  const L = makeLedger({ io, clock });
  const e = L.record({ runId: 'codex-run', agentId: 'a', usd: 0, tokens: 900000, model: '  gpt-5.3-codex  ', unmetered: true });
  A.eq(e.model, 'gpt-5.3-codex', 'model is trimmed and recorded');
  A.eq(e.unmetered, true, 'unmetered flag recorded');
  A.eq(io.rows[0].model, 'gpt-5.3-codex', 'persisted row carries model');
  A.eq(L.all()[0].unmetered, true, 'all() surfaces unmetered');
}

// ---- totals + scoped queries ----
{
  const L = makeLedger({ io: fakeIo(), clock });
  L.record({ runId: 'r1', agentId: 'alice', usd: 1.0, ts: t });
  L.record({ runId: 'r2', agentId: 'bob', usd: 2.0, ts: t });
  L.record({ runId: 'r1', agentId: 'alice', usd: 0.5, ts: t });   // same run, second turn-batch
  A.ok(Math.abs(L.totalUsd() - 3.5) < 1e-9, 'totalUsd sums every entry');
  A.ok(Math.abs(L.usdForRun('r1') - 1.5) < 1e-9, 'usdForRun sums one run across entries');
  A.ok(Math.abs(L.usdForAgent('alice') - 1.5) < 1e-9, 'usdForAgent sums one agent');
  A.ok(Math.abs(L.usdForAgent('bob') - 2.0) < 1e-9, 'usdForAgent isolates agents');
  A.eq(L.usdForRun('nope'), 0, 'unknown run -> 0');
}

// ---- usdForDay: only spend inside the trailing dayMs window counts ----
{
  const dayMs = 1000;   // tiny window for the test
  const L = makeLedger({ io: fakeIo(), clock, dayMs });
  L.record({ runId: 'old', usd: 5, ts: 100 });      // far in the past
  L.record({ runId: 'recent', usd: 2, ts: 9500 });  // inside the last 1000ms before now=10000
  t = 10_000;
  A.ok(Math.abs(L.usdForDay() - 2) < 1e-9, 'only spend within the trailing day window counts (now from clock)');
  A.eq(L.usdForDay(12000), 0, 'a later explicit "now" slides the window past every entry');
  A.ok(Math.abs(L.totalUsd() - 7) < 1e-9, 'totalUsd ignores the window');
  t = 1_000_000;
}

// ---- a prior on-disk log is loaded on construction ----
{
  const io = fakeIo([{ runId: 'pre', agentId: 'a', turns: 1, usd: 4, tokens: 10, ts: 5 }]);
  const L = makeLedger({ io, clock });
  A.eq(L.count(), 1, 'pre-existing rows loaded');
  A.eq(L.totalUsd(), 4, 'pre-existing spend counted');
  A.eq(L.usdForRun('pre'), 4, 'pre-existing run queryable');
}

// ---- corrupt io degrades to empty; a failing append never throws into the run ----
{
  const bad = { readAll() { throw new Error('disk gone'); }, append() { throw new Error('disk gone'); } };
  let L;
  A.notThrows(() => { L = makeLedger({ io: bad, clock }); }, 'construction tolerates a throwing readAll');
  A.eq(L.count(), 0, 'corrupt readAll -> empty ledger');
  A.notThrows(() => L.record({ runId: 'r', usd: 1 }), 'a throwing append does not crash record');
  A.eq(L.count(), 1, 'the RAM mirror still answers after an append failure');
  A.eq(L.totalUsd(), 1, 'in-memory total holds even when persistence failed');
}

// ---- strict record is available for paid-credit paths that must fail closed on durable append failure ----
{
  const bad = { readAll() { return []; }, append() { throw new Error('disk gone'); } };
  const L = makeLedger({ io: bad, clock });
  A.throws(() => L.recordStrict({ runId: 'r', usd: 1 }), 'recordStrict throws on append failure');
  A.eq(L.count(), 0, 'recordStrict does not update the RAM mirror when append fails');

  const io = fakeIo();
  const ok = makeLedger({ io, clock });
  const e = ok.recordStrict({ runId: 'strict', agentId: 'a', usd: 2 });
  A.eq(e.runId, 'strict', 'recordStrict returns the persisted entry');
  A.eq(ok.count(), 1, 'recordStrict updates the RAM mirror after append succeeds');
  A.eq(io.rows.length, 1, 'recordStrict persists through io.append');
}

/* ---- UNMETERED rows are excluded from the metered USD aggregates ------------------------------
   The flag was stamped at record time and had zero readers here, so one run read two different amounts:
   /api/insights said $0.00 "subscription / unmetered" while /api/budget's spentToday + lifetime and the
   budget governor's day/global pools counted the full provider-reported figure — and that phantom spend then
   blocked a later REAL run with reason 'budget'. The run is still counted; only the dollars are not. */
{
  const io2 = { rows: [], readAll: () => io2.rows.slice(), append: (e) => io2.rows.push(e) };
  const L = makeLedger({ io: io2, clock: { now: () => 5000 } });
  L.record({ runId: 'r-sub', agentId: 'hero', usd: 0.42, tokens: 42000, model: 'grok-4', unmetered: true, ts: 5000 });
  L.record({ runId: 'r-byok', agentId: 'hero', usd: 0.10, tokens: 1000, model: 'gpt', ts: 5000 });
  A.eq(L.totalUsd(), 0.10, 'totalUsd counts only metered dollars');
  A.eq(L.usdForDay(5000), 0.10, 'usdForDay too — this is what the day cap reads');
  A.eq(L.usdSince(0), 0.10, 'and usdSince');
  A.eq(L.usdForAgent('hero'), 0.10, 'and the per-agent fold');
  A.eq(L.usdForRun('r-sub'), 0, 'a subscription run contributes no metered spend');
  A.eq(L.usdForRun('r-byok'), 0.10, 'a BYOK run still does');
  A.eq(L.count(), 2, 'BOTH runs are still counted — the work happened');
  A.eq(L.all().length, 2, 'and both rows are still readable');
  A.eq(L.all().find(r => r.runId === 'r-sub').unmetered, true, 'the flag survives the round-trip');
  A.eq(L.reportedUsd(), 0.52, 'reportedUsd still exposes what the provider claimed, for a surface that wants it');
  A.eq(L.reportedUsdForRun('r-sub'), 0.42, 'per-run too');
}

/* ---- ...and the budget governor therefore cannot be blocked by subscription dollars ---- */
{
  const io3 = { rows: [], readAll: () => io3.rows.slice(), append: (e) => io3.rows.push(e) };
  const L = makeLedger({ io: io3, clock: { now: () => 5000 } });
  L.record({ runId: 'r-sub', agentId: 'hero', usd: 0.42, tokens: 42000, model: 'grok-4', unmetered: true, ts: 5000 });
  const { makeBudget } = require('../sidecar/budget.js');
  const B = makeBudget({ caps: { day: 0.30 }, ledger: L, clock: { now: () => 5000 } });
  const v = B.check ? B.check() : null;
  A.ok(!v || v.ok !== false, 'a day cap of $0.30 is NOT tripped by $0.42 of subscription spend');
}

// ---- an ended dispatch with unknown price can be settled in this process, without a new receipt ----
{
  const { makeBudget } = require('../sidecar/budget.js');
  const saved = [], receipts = new Map(); let starts = 0, finishes = 0;
  const io = {
    readAll: () => saved.map(r => Object.assign({}, r)),
    unsettled: () => [...receipts.values()].filter(r => !saved.some(e => e.runId === r.runId)),
    beginRun(r) { starts++; receipts.set(r.runId, JSON.parse(JSON.stringify(r))); },
    append(r) { saved.push(JSON.parse(JSON.stringify(r))); },
    finishRun(r) { finishes++; receipts.delete(r.runId); }
  };
  const L = makeLedger({ io, clock });
  const meta = { provider: 'openrouter', model: 'example/model', managed: false, runCapUsd: 0.75, key: 'never-store-this' };
  A.eq(L.markUnsettled('unknown'), false, 'no receipt means no new accounting claim');
  A.eq(L.beginRun('ended', 'owner', () => meta), true, 'dispatch receipt is durable before work');
  const expected = { runId: 'ended', agentId: 'owner', ts: t, provider: 'openrouter', model: 'example/model', managed: false, runCapUsd: 0.75 };
  meta.model = 'later/model'; meta.runCapUsd = 900;
  A.eq(L.pendingRuns(), 1, 'started receipt remains pending until result or explicit unknown transition');
  A.throws(() => L.settleUnsettled('ended', 0.2), 'live pending receipt cannot be manually settled');
  A.eq(L.markUnsettled('ended'), true, 'ended unknown result becomes unsettled without reboot');
  A.eq([L.pendingRuns(), L.health().complete, L.health().durable, L.health().readError], [0, false, true, 'UNSETTLED_SPEND'], 'health immediately exposes incomplete spend without inventing a write failure');
  A.eq(L.unsettledRuns(), [expected], 'original dispatch time, model, cap and explicit BYOK provenance are retained');
  A.eq(L.markUnsettled('ended'), true, 'repeat unknown notification is idempotent');
  A.eq([starts, saved.length, finishes], [1, 0, 0], 'marking does not append a new receipt, amount, or settlement');
  const exposed = L.unsettledRuns()[0]; exposed.model = 'tampered';
  A.eq(L.unsettledRuns()[0].model, 'example/model', 'returned receipt cannot mutate the recovery authority');
  const reboot = makeLedger({ io, clock });
  A.eq(reboot.unsettledRuns(), [expected], 'the already-durable receipt reconstructs identical unknown spend after restart');
  // A receipt's recorded limit is a recovery suggestion, not proof of its charge. Every chosen cap stays strict.
  const roomy = makeBudget({ ledger: L, clock, caps: { day: 5 } }).check(null, 'owner', 0);
  A.eq([roomy && roomy.scope, roomy && roomy.code, roomy && roomy.countAsUsd], ['day', 'spend_history_unavailable', 0.75], 'even a roomy chosen cap refuses until the unknown charge is explicitly settled');
  const tight = makeBudget({ ledger: L, clock, caps: { day: 0.5 } }).check('blocked', 'owner', 0);
  A.eq([tight && tight.scope, tight && tight.code, !!(tight && tight.unknown)], ['day', 'spend_history_unavailable', true], 'a tighter cap reports uncertain history, never a guessed ordinary cap stop');
  A.eq(makeBudget({ ledger: L, clock, caps: { day: 5 }, strictScope: () => false }).check(null, 'owner', 0), null, 'the shipped soft-cap policy is unchanged');
  A.eq(makeBudget({ ledger: L, clock, caps: {} }).check(null, 'owner', 0), null, 'unconfigured quotas remain opt-in');
  const settled = L.settleUnsettled('ended', 0.2);
  A.eq([settled.usd, settled.agentId, settled.model, settled.ts, settled.attested, settled.attestedAs], [0.2, 'owner', 'example/model', expected.ts, true, 'entered'], 'existing settlement path records only the owner-supplied amount with original provenance');
  A.eq([L.pendingRuns(), L.unsettledRuns().length, L.health().complete, saved.length, finishes], [0, 0, true, 1, 1], 'one durable settlement clears in-process unknown status');
  A.eq(L.markUnsettled('ended'), false, 'finished receipt cannot be resurrected');
  const settledReboot = makeLedger({ io, clock });
  A.eq([settledReboot.health().complete, settledReboot.totalUsd()], [true, 0.2], 'settlement survives restart without duplicate or missing charge');
}

// ---- a known charge whose append failed is a recovery-journal problem, never a second manual booking ----
{
  const { makeBudget } = require('../sidecar/budget.js');
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const L = makeLedger({ clock, io: { readAll: () => [], beginRun() {}, append() { throw failure; } } });
  L.beginRun('known', 'owner', { model: 'paid/model', managed: true });
  let thrown;
  try { L.recordStrict({ runId: 'known', agentId: 'owner', usd: 0.4 }); } catch (e) { thrown = e; }
  A.eq(thrown, failure, 'strict append failure preserves the original thrown error');
  A.eq([L.count(), L.health().durable, L.health().writeError], [0, false, 'ENOSPC'], 'strict failure is globally unhealthy before the caller catches it');
  A.eq(L.markUnsettled('known'), false, 'known but unsaved charge cannot become another manual booking');
  A.eq(L.unsettledRuns(), [], 'known append failure offers no settlement receipt');
  A.throws(() => L.settleUnsettled('known', 0.4), 'manual booking remains unavailable after failed strict record');
  A.eq(makeBudget({ ledger: L, clock, caps: { day: 5 } }).check('next', 'owner', 0).cause, 'write', 'strict cap sees the failed write in the same process');
  const earlier = makeLedger({ clock, io: { readAll: () => [], unsettled: () => [{ runId: 'earlier', agentId: 'owner' }], append() { throw failure; } } });
  A.throws(() => earlier.recordStrict({ runId: 'earlier', agentId: 'owner', usd: 0.4 }), 'late measured settlement also fails closed');
  A.eq(earlier.unsettledRuns(), [], 'a later known charge removes the prior manual-settlement option after failed append');
  A.throws(() => earlier.settleUnsettled('earlier', 0.4), 'failed known settlement cannot be booked twice');
  const soft = makeLedger({ clock, io: { readAll: () => [], beginRun() {}, append() { throw failure; } } });
  soft.beginRun('soft-known', 'owner'); soft.record({ runId: 'soft-known', usd: 0.3 });
  A.eq([soft.totalUsd(), soft.markUnsettled('soft-known'), soft.health().durable], [0.3, false, false], 'legacy soft record keeps observed RAM spend without offering a duplicate manual charge');
}

// ---- durable rows finish pending metadata even when optional receipt cleanup fails ----
for (const finishRun of [undefined, () => { throw new Error('cleanup unavailable'); }]) {
  const L = makeLedger({ clock, io: { readAll: () => [], beginRun() {}, append() {}, finishRun } });
  L.beginRun('complete', 'owner'); L.recordStrict({ runId: 'complete', usd: 0.1 });
  A.eq([L.pendingRuns(), L.markUnsettled('complete'), L.health().durable], [0, false, true], 'durable charge proves completion even without successful receipt cleanup');
}

// ---- token-burn audit 2026-10-17: the ledger row carries the cache-served input (additive, only when > 0) ----
{
  const L = makeLedger({ io: fakeIo(), clock });
  A.eq(L.record({ runId: 'c1', tokens: 1000, cachedTokens: 640 }).cachedTokens, 640, 'cachedTokens is recorded on the ledger row');
  A.ok(!('cachedTokens' in L.record({ runId: 'c2', tokens: 1000 })), 'no cache reads, no key (old row shape)');
}

A.report('ledger.test');
