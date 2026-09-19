---
fingerprint: 0cfef8af
slug: concurrency-limited-routines-starve-later-due-jo
title: Concurrency-limited routines starve later due jobs in store order
surface: autonomy
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: b651a8f5d
origin: audit
---

# Concurrency-limited routines starve later due jobs in store order

## Symptom

With CRON_MAX_PARALLEL enabled, later due routines can remain deferred indefinitely while earlier recurring routines repeatedly execute. Default uncapped scheduling is unaffected.

## Repro

Run `node scripts/qa/soak.mjs --minutes=5 --routines=10 --max-parallel=3 --restart-every=2 --outage-seconds=30`. The pre-fix real sidecar leaves r08/r09 with no nextRunAt advance while emitting repeated at-capacity deferrals. For a deterministic reproduction, `test/cron.tick.test.js` now creates two one-minute routines at cap one: settle the first at minute one, then tick at minute two. Before the repair the first runs again while the older second occurrence remains pending, including after a driver restart.

## Evidence

`qa/evidence/reliability-audit-0919/soak-before.json` retains the actual source-sidecar accounting failure: 61 capacity deferrals, two fireable routines with no observed advancement, no run errors, no duplicate fires. The deterministic pre-fix regression fails four assertions (wrong agent and zero completions, with and without restart). Sorting only capped plan.fire by scheduledFor makes all 214 driver assertions pass; 14 cron suites also pass. The repeated live soak and its limitations are recorded in the audit digest.

## Verdict

The repeated five-minute live soak PASS: 24 accounted occurrences, 17 fires, five already-running skips, two policy collapses, and zero lost/doubled/unexpected/off-schedule occurrences. All four ordinary fireable routines executed, including the two previously starved. Thirteen direct runs completed without error; restart preservation passed. Due-time ordering needs no volatile cursor and preserves existing concurrency, lease, advance-before-run and misfire policies. This does not promise every occurrence executes when offered load exceeds configured capacity; configured skipping remains explicit telemetry. Evidence: `qa/evidence/reliability-audit-0919/soak-after.json`.
