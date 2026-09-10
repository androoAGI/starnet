---
fingerprint: 59040543
slug: scale-soak-misclassifies-separate-scheduler-tick
title: Scale soak misclassifies separate scheduler ticks between store polls
surface: release
severity: P2
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Scale soak misclassifies separate scheduler ticks between store polls

## Symptom

The 50-routine release soak returns FAIL for an unexpected fire even though the retained run history shows a delayed catch-up followed by the next normal scheduled occurrence on separate scheduler ticks.

## Repro

Run `node scripts/qa/soak.mjs --minutes=10 --routines=50 --max-parallel=8 --restart-every=4 --outage-seconds=150`. Timing-dependent: the 15-second store poll must straddle the catch-up and the following normal tick. `test/soak.test.js` deterministically models that polling gap and failed two assertions before the checker repair.

## Evidence

Original receipt: `.dogfood/release-0112-closeout/scale/soak-receipt.json` on `31ce0e785`. It reports zero lost/doubled occurrences, one unexpected fire for r20 at 20:33:52.077Z. The retained runs show its catch-up starting at 20:33:49.808Z for 20:30:52.077Z, and its next run starting at 20:33:59.871Z for 20:33:52.077Z. These are distinct ticks ten seconds apart, both between store polls. The old checker treats every unobserved intermediate occurrence as collapsed.

The repair joins console fire IDs to durable autonomy decision timestamps, then uses the real `cron.planTick` to prove any intermediate head before accepting it. Missing timestamps, duplicate fires, off-schedule fires and actual catch-up bursts remain failures. All 272 soak assertions pass after the repair. New runs also retain the complete accounting inputs for replay.

## Verdict

Source checker repaired; fresh live scale-soak verification pending. This is a QA accounting defect, not evidence that the station duplicated work. The original failed receipt remains retained.
