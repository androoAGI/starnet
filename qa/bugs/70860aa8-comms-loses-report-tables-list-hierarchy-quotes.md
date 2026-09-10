---
fingerprint: 70860aa8
slug: comms-loses-report-tables-list-hierarchy-quotes
title: COMMS loses report tables list hierarchy quotes and named links
surface: sessions
severity: P1
status: fixed
found: 2026-09-10
lane: hermes-stress-0910
fix: 19e6aebded46145b75525616bdc384c976b6fe56
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

Source and browser verified in isolated agent/hermes-stress-0910. Three viewport sizes, wide-table mouse/keyboard scrolling, exact code/report clipboard contents, reload, actual sidecar restart, and selection/scroll during streaming passed. Browser checks found and fixed source-copy flattening and narrow-table word splitting. Focused 33 assertions and full fast 757/757 passed. See qa/audits/hermes-stress-2026-09-10/BROWSER_VERIFICATION.md. Not merged or installed-verified; no live-model parity claim.
