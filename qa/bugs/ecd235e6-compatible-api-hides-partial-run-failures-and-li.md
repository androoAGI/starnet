---
fingerprint: ecd235e6
slug: compatible-api-hides-partial-run-failures-and-li
title: Compatible API hides partial run failures and limits
surface: providers
severity: P1
status: fixed
found: 2026-09-10
lane: hermes-stress-0910
fix: f952835ab7e078d0f9dae490cbb52e7b9c8cc29f
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

Source-fixed in isolated agent/hermes-stress-0910; full fast 757/757 and HTTP 110/110 passed. See qa/audits/hermes-stress-2026-09-10/EXECUTION.md. Not merged or installed-verified; no live-model parity claim. Actual sidecar partial-failure probe passes three repetitions per native/sync/stream surface; adapter regressions cover eight terminal outcomes and synchronous throw.
