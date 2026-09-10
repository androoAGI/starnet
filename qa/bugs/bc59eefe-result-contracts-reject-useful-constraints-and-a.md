---
fingerprint: bc59eefe
slug: result-contracts-reject-useful-constraints-and-a
title: Result contracts reject useful constraints and API JSON formats are ignored
surface: autonomy
severity: P1
status: fixed
found: 2026-09-10
lane: hermes-stress-0910
fix: 61eeac2b40c9fd0e2e0a5d2b342f44de74119078
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

Source-fixed in isolated agent/hermes-stress-0910; full fast 757/757 and HTTP 110/110 passed. See qa/audits/hermes-stress-2026-09-10/EXECUTION.md. Not merged or installed-verified; no live-model parity claim. Twelve actual-sidecar schema cases pass with exact usage. Hostile output-only repair makes one generation, advertises no tools and writes no file. Nested-schema safety regressions pass. Additional live worker spawn/resume campaign coverage remains pending.
