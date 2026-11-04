---
fingerprint: b131cb72
slug: routine-publication-stalls-when-another-target-f
title: Routine publication stalls when another target finishes during history persistence
surface: channels
severity: P1
status: fixed
found: 2026-11-04
lane: agent/turn-identity-1103
fix: 5fa8c331e4c8b48c77593d9666fe196589491a3e
origin: audit
---

# Routine publication stalls when another target finishes during history persistence

## Symptom

A routine delivered to two chats can remain pending after both replies and their canonical history rows are durable. Its delivery records stay retained instead of completing finalization. This was found in the unlanded C9 publication implementation during its required lifecycle proof.

## Repro

1. Run the two-target scenario in test/routine-delivery.lifecycle.test.js with the exact saved source06 routine-delivery module.
2. Hold the first target's canonical publication after entering the persistence barrier. Let the second target finish transport while publication is held.
3. Open the barrier, retry finalization and inspect the actual canonical rows, cron pending state and retained delivery records.

The regression preserves both delivered replies, both canonical rows and the no-resend checks. The failure concerns finalization after the asynchronous publication boundary.

## Evidence

Exact source06 control (routine-delivery SHA-256 4D74BE95 prefix) with the final lifecycle fixture failed 2 of 78 assertions; 76 positive assertions passed. The current module passes all 78. The repair adds a target to deliveredTargets only after strict publishRecord evidence succeeds, so a target that finishes during the await is represented consistently in the publication receipt.

Owner receipts in C:/Users/andro/gen-trees/_logs/codex-overnight-1103/turn-identity-c9-publication-consumer07-* retain actual child exits: old PID58296 exit1, current PID22576 exit0, and current test/routine-history.publication.test.js PID10396 exit0 with 99 assertions. The new actual-host test/routine-history.publication.http.test.js passed 27 assertions after the source change (PID64932 exit0, turn-identity-c9-consumer-close07b-http-01). It uses the real sidecar and durable stores with local synthetic provider/transport, verifies retained records on publication failure, then restart publication without another paid run or transport send.

All 28 affected compatibility files and 12 closing laws passed with the recorded applicable source hashes. The routine-only delivery golden was independently compared: all unrelated scenarios and all routine non-result transport traces stayed identical. Resource discovery later reported unrelated external test activity; no failure is causally attributed to it.

## Verdict

Source-fixed in 5fa8c331e4c8b48c77593d9666fe196589491a3e. Completion bookkeeping now follows fresh successful canonical publication evidence across the await, without weakening receipt validation or repeating transport. The exact old/current lifecycle control closes this race. Combined candidate gates, packaged-app verification and live external-provider behavior remain separate; this record claims focused source and actual local-host proof only.
