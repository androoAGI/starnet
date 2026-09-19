---
fingerprint: 1746d326
slug: unavailable-spend-history-grants-capped-runs-fre
title: Unavailable spend history grants capped runs fresh headroom
surface: providers
severity: P1
status: open
found: 2026-09-19
lane: reliability-audit-0919
fix:
origin: audit
---

# Unavailable spend history grants capped runs fresh headroom

## Symptom

Unreadable, corrupt, truncated, or unsuccessfully appended spend history can look like unused configured spending headroom.

## Repro

Run `node test/spend-authority.test.js` and `node test/spend-authority.http.test.js`. Inject an EACCES read or ENOSPC append, then restart and attempt another capped paid run.

## Evidence

`qa/evidence/reliability-hardening-0919/spend-before.log` captures the original failed assertion. Real-sidecar restart proof is in `spend-http.log`; browser budget truth is in `live-budget-unknown.json`.

## Verdict

Candidate patch preserves durable dispatch/settlement receipts, rejects unknown configured pools, reports null totals and preserves known caps. Full gates pending. Customer overnight-spend incident remains separately unresolved.
