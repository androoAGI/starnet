---
fingerprint: a9ebad1a
slug: compaction-calls-lose-booked-usage-and-bypass-pe
title: Compaction calls lose booked usage and bypass per-attempt spending limits
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: spend-governor-1103
fix: 24a944920237b59148f3dc090d56c9b8b6d4c4ec
origin: audit
---

# Compaction calls lose booked usage and bypass per-attempt spending limits

## Symptom

A summary call can spend money or sign-in tokens without retaining that observed usage when the stream throws or is cancelled. Later summary chunks and retries can also start after the run has reached its configured ceiling.

## Repro

1. Drive the actual summarizer through the real loop using a synthetic Anthropic stream. Emit observed usage, then throw or abort.
2. Repeat with one completed chunk followed by a failing chunk.
3. Set a chosen dollar/sign-in ceiling reached by the first chunk and observe whether another summary starts. Use a real RunSpendPool with an expensive auxiliary model to check the actual reservation.

## Evidence

Registered regressions: test/spend.compaction-accounting.test.js, test/spend.compaction-admission.test.js, test/spend.compaction-pool.test.js and test/spend.compaction-accounting.http.test.js. Exact old-module controls lose the $0.10 floor, issue 8 summary calls instead of 1, and wrongly permit a sibling while expensive auxiliary work holds the family pool. Current cases retain observed floors $0.10/$0.21/$0.10/$0.11; capped dollar/sign-in runs stop at 1 summary and 0 main calls; uncapped controls continue. Actual request/model/cost bounds govern auxiliary calls, retries and hold/wake; unknown and known-free controls retain their policy. Real sidecar finalizer/restart proof retains $0.13/210 tokens/2 IDs and $0.24/320 tokens/3 IDs with usageMissing and byte-identical ledger restart. Receipts: C:/Users/andro/gen-trees/_logs/codex-overnight-1103/spend-compaction-accounting-control-red.log, spend-compaction-accounting-green.log, spend-compaction-admission-control-red.log, spend-compaction-admission-green.log, spend-compaction-pool-control-red.log, spend-compaction-pool-green.log, spend-compaction-http-control-red.log and spend-compaction-http-diagnostic.log.

## Verdict

Each actual summarizer attempt now admits through the loop-owned governor with its actual call bound and settles observed usage in finally. Partial floors, IDs and missing-usage flags survive failure/cancel; aggregate completion does not double book. No usage is invented. Existing positive-known-floor settlement semantics are preserved. The earlier current HTTP 2-vs-1 extra-main-call failure and initial pool liveness failures remain unattributed in spend-compaction-http-current-red.log and spend-m234-reader-run-spend-pool.log; unchanged diagnostic/standalone reruns passed. No live paid-provider or installed-build proof.
