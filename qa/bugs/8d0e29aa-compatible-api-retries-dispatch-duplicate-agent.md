---
fingerprint: 8d0e29aa
slug: compatible-api-retries-dispatch-duplicate-agent
title: Compatible API retries dispatch duplicate agent runs
surface: providers
severity: P1
status: fixed
found: 2026-09-10
lane: hermes-stress-0910
fix: 4d5ee74c170330c977c766f6be200ffb4313f95c
origin: audit
report: docs/HERMES_STRESS_AUDIT_2026-09-10.md
---

# Compatible API retries dispatch duplicate agent runs

## Symptom

Matching Idempotency-Key requests start multiple primary agent runs.

## Repro

Run test/request-idempotency.e2e.test.js. Original reproducer and input are in docs/HERMES_STRESS_AUDIT_2026-09-10.md and qa/audits/hermes-stress-2026-09-10/.

## Evidence

The live sidecar now coalesces three concurrent requests, rejects changed-body conflicts and replays the identical response after a process restart. Keyed streams share incremental progress; terminal frames wait for durable persistence. Disconnect and auth-rotation siblings also pass.

## Verdict

Source-fixed in isolated agent/hermes-stress-0910; full fast 757/757 and HTTP 110/110 passed. See qa/audits/hermes-stress-2026-09-10/EXECUTION.md. Not merged or installed-verified; no live-model parity claim. Actual sidecar coalesces callers, rejects changed payloads, replays after restart, preserves incremental streams and survives caller disconnect. Rotation, orphan, corrupt-store and write-failure regressions pass. Full-file ledger load/soak remains unmeasured.
