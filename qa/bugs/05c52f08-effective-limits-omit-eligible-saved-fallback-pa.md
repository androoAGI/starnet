---
fingerprint: 05c52f08
slug: effective-limits-omit-eligible-saved-fallback-pa
title: Effective limits omit eligible saved fallback payers
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: spend-governor-1103
fix: f796a11ef21a65bfdc13b5dac6356559c021dd4c
origin: audit
---

# Effective limits omit eligible saved fallback payers

## Symptom

A station using sign-in or local primary models can hide the API-key dollar and unpriced-token limits that govern its eligible saved OpenRouter fallback.

## Repro

1. Boot the real sidecar with a synthetic Codex sign-in or Ollama primary roster.
2. Save a nonempty OpenRouter fallback chain and a synthetic usable fallback credential/endpoint.
3. Read /api/budget/status.effective, then remove the chain/credential or enable an incompatible managed deployment and compare payer groups.

## Evidence

test/effective-limits.fallback.http.test.js exact pre-repair index control fails because the metered payer is missing. Current real-host scenarios pass for Codex and Ollama with persisted eligible fallbacks; environment-only, empty-chain, missing-key and managed-mismatch controls exclude that payer. Child fetch is restricted to the exact synthetic server origin; generation paths including Ollama chat/generate stay at zero. Receipts: C:/Users/andro/gen-trees/_logs/codex-overnight-1103/spend-s5-fallback-control-red.log and spend-s5-fallback-isolated-green.log. Existing saved-provider-fallback.e2e.test.js also passes real adapter, credential isolation and restart coverage.

## Verdict

Readback includes only persisted nonempty eligible fallbacks using the existing credential/base readiness and billing policy. It adds no routing, admission or account refresh behavior. Independent second money review closed at index BD7ED63F; layout acceptance and combined gates remain separate.
