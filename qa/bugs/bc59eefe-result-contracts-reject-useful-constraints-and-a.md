---
fingerprint: bc59eefe
slug: result-contracts-reject-useful-constraints-and-a
title: Result contracts reject useful constraints and API JSON formats are ignored
surface: autonomy
severity: P1
status: open
found: 2026-09-10
lane: hermes-stress-0910
fix:
origin: audit
report: docs/HERMES_STRESS_AUDIT_2026-09-10.md
---

# Result contracts reject useful constraints and API JSON formats are ignored

## Symptom

Useful JSON constraints are refused and API response_format is silently ignored.

## Repro

Run test/result-contract.test.js. Original reproducer and input are in docs/HERMES_STRESS_AUDIT_2026-09-10.md and qa/audits/hermes-stress-2026-09-10/.

## Evidence

Six positive/negative contract pairs pass. Live JSON-format probes now report failed validation after one output-only repair, with both calls included in usage.

## Verdict

Implementation in the isolated branch; full gates and remaining live evidence pending.
