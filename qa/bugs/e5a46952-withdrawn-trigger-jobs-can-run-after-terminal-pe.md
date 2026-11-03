---
fingerprint: e5a46952
slug: withdrawn-trigger-jobs-can-run-after-terminal-pe
title: Withdrawn trigger jobs can run after terminal persistence fails
surface: autonomy
severity: P1
status: fixed
found: 2026-11-03
lane: line-intake-next-1103
fix: ebded142236c1bca7bcf8df5c56877a3f2177c67
origin: audit
---

# Withdrawn trigger jobs can run after terminal persistence fails

## Symptom

A trigger job withdrawn by disabling the trigger or pressing E-STOP can begin work after automation resumes if saving its terminal record failed. A job scheduled to start in the next microtask can also escape immediate disable/remove/E-STOP. One queued write failure can skip the host's live trigger stop markers and controller aborts.

## Repro

Run test/line-hook-cancellation.test.js with the actual TriggerRunner, LineRunner book and durable DomainStore. Keep one job active, enqueue more jobs on multiple triggers, refuse the first queued terminal write, withdraw work, restore storage and resume before releasing the active job. Repeat withdrawal immediately after enqueue but before the dispatch microtask, and with a folder item without a jobId. test/trigger-halt-containment.test.js executes both complete production host stop functions with actual Halt primitives and RunTable, injecting the queued write refusal while live and late hub owners remain.

## Evidence

gen-trees/_logs/codex-overnight-1103/intake-withdrawal-final-old.log records 41 failed assertions out of 176 against exact089cde60f TriggerRunner; intake-withdrawal-final-current.log passes176. The saved original and loader are intake-withdrawal-original-sources.json and intake-withdrawal-control.cjs. Intermediate logs retain the first wrong durable stop-code field and missing required runOnce fixture input; corrected final comparisons use identical fixtures against old/current production source. intake-host-halt-old.log records13/62 failures with the original host source; intake-host-halt-current.log passes62. intake-withdrawal-affected.log passes37 affected files including actual channel/trigger/line-job HTTP, orphan ownership, workflow readers and existing process-fault/E-STOP checks. The final additional folder test changed no product source and passed in the176-assertion control pair.

## Verdict

Source-fixed in ebded1422. All waiting identities acquire the existing-owner dispatch barrier before any terminal write. The exact scheduled item remains reachable until synchronous hub adoption. Failed writes retain facts, capacity and cancellation ownership; successful retries never buy provider work. E-STOP marks all trigger queues before attempting persistence, and the host independently retains live hub containment when queue persistence throws. Fault cause and already-recorded work/spend survive retries. Independent queue review and root host review are recorded in intake-final-independent-review.md and the shared handoff. Combined integration gates, installed-app and live-account acceptance remain separate.
