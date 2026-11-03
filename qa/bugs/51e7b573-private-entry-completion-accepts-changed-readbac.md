---
fingerprint: 51e7b573
slug: private-entry-completion-accepts-changed-readbac
title: Private entry completion accepts changed readback
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: line-hold-next-1103
fix: 7f7a2689a1f57ed31da92e3465e67b72d5e8cd31
origin: audit
---

# Private entry completion accepts changed readback

## Symptom

In the unactivated source01 private entry adapter, a checkpoint that saved a different valid terminal text/cost could be reported confirmed after its returned readback differed or its acknowledgment was lost. Binding/job validity alone did not prove that the saved result was the actual invocation's result. This was found during source review before activation; it is not a claim that a public resume API or shipped paid replay path existed.

## Repro

1. Run test/line-entry.invocation.test.js with LINE_ENTRY_INVOCATION_CONTROL pointing to the preserved source01 helper and the exact SHA256 DA1BE807CD2EF3D25AE0F37CF9DCB1FD07E2F529EC50F07D02383DE60F42229F. The actual canonical owners receive a different valid observed text/USD, with returned and lost acknowledgments; the control also changes a requested uncertainty receipt.
2. Run the same fixture with the current helper. Compare exact canonical observation/uncertainty, preserved actual terminal evidence, separate storage/execution errors and no further invocation. The suite also exercises concurrent same-job requests, dequeue identity changes, STOP during authority await and unsupported/missing usage evidence.
3. Run test/line-entry.invocation.http.test.js with the actual isolated sidecar and local synthetic OpenRouter transport. It installs a compiled fixture route and explicit test-only fresh-authority callback, then proves actual finalizer observation, exact EIO after successful terminal work, restart and no provider re-entry. Repeat with the preserved exact23c index control, which has no private dequeue/finalizer integration.

## Evidence

Owner unit current127 GREEN; exact source01 shared-API control RED8/127 with119 positives and child-verified source hash. Receipts line-hold-h3-invocation-02-receipts.jsonl preserve PIDs/exits and full reports. Actual HTTP fixture04 current15 GREEN; exact23c host control RED7/16 with9 positives, including child source verification. Receipts line-hold-h3-invocation-04-receipts.jsonl preserve exact commands/exits. Synthetic transport requests usage.include and returns cost0; the actual host cost owner proves unpriced=false and usageMissing=false. The write-fault row requires exact EIO/message plus actual successful full text, not merely any error.

Earlier actual HTTP reds remain preserved: fixture02 omitted current workflow membership and bought zero calls; fixture03 reached the real provider but custom price authority was unknown, so the product correctly refused an unpriced observation. Neither is presented as a fixed product defect. No assertion was relaxed to make those fixtures pass.

Focused source manifest line-hold-h3-invocation-source-05.json pins product02 and fixture-only dependency adapters. Root reviewed exact-readback repair and private finalizer ordering. All12 affected files and seven laws passed with actual exit0 records in line-hold-h3-invocation-affected05-{http,pure}-receipts.jsonl; this includes the real allocated admission HTTP and full lifecycle562, ordinary credential123, four actual canonical-owner persistence/receipt fixtures, enrollment observations and lifecycle owners. Syntax3 also passed. All11 source05 hashes remained unchanged. Source checkpoint7f7a2689a1f57ed31da92e3465e67b72d5e8cd31 contains the exact reviewed implementation and tests.

## Verdict

Source-fixed in7f7a2689a1f57ed31da92e3465e67b72d5e8cd31. The adapter retains the exact validated observation before attempting a write. Readback/lost-ACK reconciliation must match that observation, or the exact intended uncertainty receipt. Contradictory persistence stays unconfirmed/unresolved and preserves actual terminal text/cost plus storage error; genuine exact landed acknowledgments may reconcile without dispatching again. Actual runOnce finalizer wiring is private, one-use, text-only and guarded by production authority:null.

No public hold/resume, paid activation, saved-floor authority, fresh-ledger bootstrap, continuation adoption/booking, walker resumption, terminal publication, installed-app or whole-lane acceptance follows from this checkpoint. Missing-usage evidence remains unresolved; unpriced/file-bearing evidence cannot become a confirmed zero-dollar receipt.
