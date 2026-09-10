---
fingerprint: ecd235e6
slug: compatible-api-hides-partial-run-failures-and-li
title: Compatible API hides partial run failures and limits
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: hermes-stress-0910
fix:
origin: audit
report: docs/HERMES_STRESS_AUDIT_2026-09-10.md
---

# Compatible API hides partial run failures and limits

## Symptom

API clients receive finish_reason stop after partial provider failure. Run status also labels limits completed and discards failed output and usage.

## Repro

Run the saved partial SSE provider probe in qa/audits/hermes-stress-2026-09-10/probes against the actual sidecar. Send sync and streaming requests; compare native terminal events with API finish reasons. Regression: test/openai-outcomes.test.js.

## Evidence

qa/audits/hermes-stress-2026-09-10/starnet-partial.json records three repetitions per surface. sidecar/openai-compat.js mapped errors with text to stop. The fix uses host terminal events and preserves output plus usage across all outcomes.

## Verdict

Repair in progress; focused regression and live provider probe required before closure.
