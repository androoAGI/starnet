---
fingerprint: 504d28fa
slug: provider-fallback-prices-outgoing-usage-with-the
title: Provider fallback prices outgoing usage with the replacement cost engine
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: spend-governor-1103
fix: 24a944920237b59148f3dc090d56c9b8b6d4c4ec
origin: audit
---

# Provider fallback prices outgoing usage with the replacement cost engine

## Symptom

Observed usage from a failed provider attempt can become zero or be priced at a different rate after the run switches provider.

## Repro

1. Run the real loop through two synthetic Anthropic transports. The outgoing adapter reports billable usage before a retryable failure.
2. Give the replacement cost catalog no entry for the outgoing model, then a contradictory rate for that model.
3. Compare the retained outgoing floor plus the new call to the original provider catalog.

## Evidence

test/spend.fallback-cost.test.js uses actual adapters/loop and two synthetic routes. Exact saved pre-repair source records $0.055 instead of $0.155. Fixed missing-model and contradictory-catalog cases both retain $0.155. Receipts: C:/Users/andro/gen-trees/_logs/codex-overnight-1103/spend-fallback-cost-control-red.log and spend-fallback-cost-green.log. Affected fallback.test, billing-class.parity and receipt tests passed in the lane handoff.

## Verdict

The loop snapshots the pricing engine for each attempt and books/clears outgoing usage before provider, model, cost or payer mutation and new-route compaction. The new route cannot rewrite the old charge. Source and synthetic transport proof only.
