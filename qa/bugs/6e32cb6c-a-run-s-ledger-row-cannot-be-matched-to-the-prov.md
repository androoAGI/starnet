---
fingerprint: 6e32cb6c
slug: a-run-s-ledger-row-cannot-be-matched-to-the-prov
title: A run's ledger row cannot be matched to the provider's charge because no generation id is kept
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 50147a05376c7c317b18741f3c2765bc3577a5ba
origin: audit
---

# A run's ledger row cannot be matched to the provider's charge because no generation id is kept

## Symptom

One paid OpenRouter run cannot be proven against what OpenRouter charged: StarNet's books agree with themselves, but the key's usage moved by a slightly different amount and there is no generation id to look the charge up by.

## Repro

1. Read the key's usage (`GET https://openrouter.ai/api/v1/key`).
2. Run one message on a paid model through COMMS.
3. Compare the ledger row to the key-usage delta once it settles.

## Evidence

The sweep's one paid smoke (mistralai/mistral-nemo, 2026-10-20 05:44 UTC): ledger `{"usd":0.0004234896,"tokens":25578,"cachedTokens":16,"model":"mistralai/mistral-nemo"}` = /api/runs row = /api/insights byModel ($0.000423) = /api/budget/status spentToday/lifetime = page `Harness.totals()` `{"tokens":25578,"cost":0.0004234896,"calls":1}`. OpenRouter key usage 218.206740941 → 218.207180402 (delta $0.000439461, stable over 45 s). Gap: $0.0000160 (3.6%). The key is shared (usage_daily $2.29 that day) and no StarNet run journal or pending-spend receipt was left behind, so the gap is most likely another consumer of the key, but it cannot be proven either way: `sidecar/providers/openrouter.js` never keeps the stream's `id` (the generation id OpenRouter's `/api/v1/generation?id=` would price exactly), and the ledger row has no field for it.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Source repair 50147a05376c7c317b18741f3c2765bc3577a5ba preserves exact provider call IDs through supported adapters, loop attempts and durable ledger rows (first 32 IDs plus identified-attempt count). IDs are internal receipts, never fabricated usage. Follow-up 24a944920237b59148f3dc090d56c9b8b6d4c4ec preserves paid compaction floors and receipts on error/cancel and outgoing fallback pricing.

Registered regressions: test/ledger.generation-id.test.js, test/ledger.generation-id.http.test.js, test/spend.compaction-accounting.test.js and test/spend.compaction-accounting.http.test.js. Exact original nine-module control failed 25/131 assertions; fixed 131 passed. Original real-sidecar control failed 5/17; fixed 17 passed, including main and station one-shot rows and byte-identical restart. Synthetic transport endpoints only; no live key was charged. Evidence receipts are in C:/Users/andro/gen-trees/_logs/codex-overnight-1103/spend-s4-control-red.log, spend-s4-green.log, spend-s4-http-control-red.log and spend-s4-http-green.log.

This closes the missing-receipt source defect. The historical shared-key charge delta was not reconciled, no customer billing was verified, and providers which report no call ID still have none.
