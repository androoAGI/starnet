---
fingerprint: 7ad1c1c0
slug: completed-overseer-review-missing-from-canonical
title: Completed overseer review missing from canonical conversation history
surface: autonomy
severity: P1
status: fixed
found: 2026-11-03
lane: line-intake-next-1103
fix: acff023c1c8e5776686277d3d0c0023887f6c339
origin: audit
---

# Completed overseer review missing from canonical conversation history

## Symptom

A delegated review is shown as finished, but a message queued while it finishes reaches the provider without that review in its conversation history. A failed public transcript write can also leave the review incorrectly reported as done.

## Repro

Run test/e2e.overseer.test.js: use the real sidecar and scripted local provider, dispatch a worker, hold the automatic review briefly, and queue a new user turn with the client's captured prior history. The new provider prompt must include the completed review. test/overseer-publication.http.test.js refuses only the strict public delivery write, confirms pending state and one review invocation, restarts with storage restored, and confirms one durable public answer without another invocation. test/overseer-delivery.test.js covers full answers beyond the run preview cap and undo/deletion before publication.

## Evidence

gen-trees/_logs/codex-overnight-1103/batch3-ae7429714-http.log records the original e2e failure at step235. overseer-queued-review-1942.log independently reproduced it on combined e0b610f: the finished assistant answer was durable as kind station but absent from the queued prompt. The first 1941 observer was invalid because it expected the retired monolithic transcript file; that artifact is retained separately. overseer-e2e-current-2003.log passes the queued prompt and actual restart/lost-acknowledgement scenario (62s, exit0). overseer-publication-current-2002.log passes real strict publication fault, repeated publication-only retries, restart, one public row and the next request (17s, exit0). The first publication fixture posted stale history without a queue or identity marker after restart; it failed its last assertion and was corrected to capture the actual public transcript, preserving the original log. The original busy-lock fault fixture lacked the segmented complete reader after a write fault; the corrected actual-disk fixture passed51. Independent undo/deletion findings reproduced4 failed assertions in overseer-delivery-undo-control.log; the repaired writer passed33 in overseer-delivery-undo-current.log. The canonical Store visibility owner is reused rather than duplicating tombstone rules.

## Verdict

The final repair passes all16 focused closing files in overseer-closing-2005.log (exit0,38s), including the intentional-removal cancellation branch, existing overseer ownership/concurrency, stop/update containment, source laws and list integrity. Independent review is closed in overseer-publication-independent-review.md. Publish one strict canonical delivery before acknowledging done in both live completion and orphan/restart reconciliation. Publication failures retain the executed run id and retry storage only; intentional undo/deletion cancels an unpublished review. Existing delivered identities remain immutable and cannot be revived. Preserve hidden station execution, full text, redaction and taint provenance. Combined gates and installed-app/customer acceptance remain separate.
