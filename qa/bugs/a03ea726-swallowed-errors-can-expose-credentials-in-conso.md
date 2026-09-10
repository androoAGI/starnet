---
fingerprint: a03ea726
slug: swallowed-errors-can-expose-credentials-in-conso
title: Swallowed errors can expose credentials in console warnings
surface: release
severity: P1
status: fixed
found: 2026-09-10
lane: cleanup-0112-0910
fix: 0a3a605a9c41ecf944760782a4938ec442d02e6c
origin: audit
---

# Swallowed errors can expose credentials in console warnings

## Symptom

A swallowed error message reaches console.warn without passing through the existing credential scrubber. The diagnostics regression emits a synthetic OpenRouter-shaped key into the captured fast-gate log.

## Repro

Run node test/diagnostics.test.js with output captured under .dogfood, then run node scripts/lint-evidence-secrets.mjs. Before this fix the linter flags the aux.test.envelope warning.

## Evidence

The first full cleanup fast gate stopped at step 181/753 because its own captured diagnostic-test output matched three key patterns. The value was synthetic fixture data. sidecar/failopen.js now applies the existing context.redact helper to both message and tag; test/failopen.test.js captures console output and counter tags and verifies no credential survives. The diagnostic test log now passes the unchanged evidence-secret linter.

## Verdict

Source repair and focused regressions verified. Final full-gate receipt is tracked in docs/AUDIT_0.11.1_FOR_0.11.2.md. No installed/customer recovery claim.
