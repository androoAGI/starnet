---
fingerprint: 70860aa8
slug: comms-loses-report-tables-list-hierarchy-quotes
title: COMMS loses report tables list hierarchy quotes and named links
surface: sessions
severity: P1
status: open
found: 2026-09-10
lane: hermes-stress-0910
fix:
origin: audit
report: docs/HERMES_STRESS_AUDIT_2026-09-10.md
---

# COMMS loses report tables list hierarchy quotes and named links

## Symptom

COMMS shows raw table pipes, quote markers and named-link syntax and flattens list hierarchy.

## Repro

Run test/chat-code-copy.test.js. Original reproducer and input are in docs/HERMES_STRESS_AUDIT_2026-09-10.md and qa/audits/hermes-stress-2026-09-10/.

## Evidence

Semantic report rendering and injection checks are added. Browser live verification is blocked by automatic tool approval; no visual completion claim.

## Verdict

Implementation in the isolated branch; full gates and remaining live evidence pending.
