---
fingerprint: 24b375c9
slug: late-cancelled-loop-settlement-strands-the-resum
title: Late cancelled loop settlement strands the resumed iteration
surface: autonomy
severity: P1
status: fixed
found: 2026-09-07
lane: release-blockers-0907
fix: 035513a6d
origin: audit
---

# Late cancelled loop settlement strands the resumed iteration

## Symptom

Pausing a loop while its host check is completing and immediately resuming can leave the replacement iteration stuck as running. Other loops on the same project then wait indefinitely.

## Repro

1. Run `node test/loops-check.e2e.test.js` against a real disposable sidecar and git project.
2. Let the provider finish a pass, then pause while its host check or harvest is still pending.
3. Resume and let a replacement pass claim the loop before the old host work completes.
4. Resolve the old check/harvest: the replacement remains running without a live lease.

`test/loopjob-driver.test.js` controls this ordering deterministically for late check, successful harvest and rejected harvest.

## Evidence

Original live HTTP failure: `C:/Users/andro/gen-trees/release-blockers-0907/.bugloops/blockers/http.log`, step 55/102.
The preserved `http-failure-workspace/autonomy.ledger.jsonl` records cancellation of run `a05bc393-6963-4ac3-8188-a469c6385c47`, a replacement fire `d88b2220-3482-4ad3-99c9-00c7df664fa8`, then a late act for the cancelled run. `loops.json` retains iteration 3 as running; no provider run for it was recorded.

Root cause: `sidecar/loopjob-driver.js` settlement deleted `leases` by loop ID without checking its run ID. The asynchronous check/harvest continuation could settle an already-cancelled generation and delete the replacement's lease.

The deterministic negative baseline fails seven assertions across all three late-completion seams (`loop-race-before.log`). With the guard, all 175 driver assertions pass (`loop-race-after.log`); the original real HTTP scenario passes 33 assertions (`loop-race-live-after.log`). These are source tests, not installed-candidate acceptance.

## Verdict

The repair fences settlement and error cleanup by current run ownership and prevents a cancelled check from starting harvest. Full branch gates and installer rebuilding remain pending.
