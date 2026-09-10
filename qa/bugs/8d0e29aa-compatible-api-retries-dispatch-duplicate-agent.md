---
fingerprint: 8d0e29aa
slug: compatible-api-retries-dispatch-duplicate-agent
title: Compatible API retries dispatch duplicate agent runs
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: hermes-stress-0910
fix:
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

Implementation in the isolated branch; full gates and remaining live evidence pending.
