---
fingerprint: 80de2a75
slug: a-run-cancelled-mid-stream-is-recorded-as-a-know
title: A run cancelled mid-stream is recorded as a known zero-dollar run instead of spend unknown
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: bd501893e
origin: audit
---

# A run cancelled mid-stream is recorded as a known zero-dollar run instead of spend unknown

## Symptom

When a run is stopped mid-answer (E-STOP, Stop, a lowered dial), its history row and the spend ledger say it cost exactly $0 — although the provider had already streamed part of an answer, which providers bill. Interrupted runs say "spend unknown"; cancelled ones claim free work.

## Repro

1. Mock provider streams one token and then hangs; start any run (here a night-shift DO call).
2. Cancel it (`POST /api/halt`).
3. Read the run's row in `runs.jsonl` / `GET /api/runs` and `ledger.jsonl`.

## Evidence

Live (scratchpad probeI `halt`): `runs: { reason:"cancelled", usd:0 }` and `billingLedger: { usd:0, turns:1 }` with no `spendUnknown`, for a call that had streamed "Working on it". Contrast `syncInterruptedRunHistory` in `sidecar/index.js`: `usd: settled ? settled.usd : 0, spendUnknown: !settled` ("never a guessed $0"). Anchor: the run-end `runStore.record({ … usd: finalUsd … })` in `sidecar/index.js` records the cancelled run's unreconciled 0 as known.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed in `bd501893e`, refined by `3ab283656` and `94e186780` (2026-10-23; all ancestors of trunk, first released in v0.14.0). A Stop or E-STOP that cuts a model call mid-stream is flagged by the loop (streamCut): a run that booked nothing records spendUnknown, one that booked something keeps those dollars as a floor (usageMissing, read as "at least"), and a Stop that cut no call carries no flag. A Claude subscription call is no floor, and a Stop while a model only reasons is a cut call. Never a known $0 for a cut call. Regression: test/cancel-spend-unknown.http.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
