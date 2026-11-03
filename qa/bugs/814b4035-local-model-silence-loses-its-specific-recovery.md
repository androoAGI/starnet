---
fingerprint: 814b4035
slug: local-model-silence-loses-its-specific-recovery
title: Local model silence loses its specific recovery guidance
surface: world
severity: P2
status: fixed
found: 2026-11-03
lane: agent/batch3-runtime-fixtures-1103
fix: fb33da958e1b8998a661e793d8a5f0a0aa44129a
origin: audit
---

# Local model silence loses its specific recovery guidance

## Symptom

A run with the host local_timeout code shows a generic resend and bug-report post-mortem instead of the local server log and smaller-model guidance, and falsely says that no useful work occurred.

## Repro

Run test/slag-known-error-kinds.test.js. It sends the actual FriendlyError local_timeout verdict through SlagLog.diagnose with two prior turns and compares the recovery message and cause.

## Evidence

Exact saved old SlagLog with the expanded test fails 5 of 210 assertions; current source passes all 210. The old failure includes the generic resend/report door and false work-loss claim. The generic timeout and unknown cases retain their existing expectations. Control module batch3-slaglog-old.js and before/after receipt batch3-root-focused-01.log are preserved under gen-trees/_logs/codex-overnight-1103. Independent review found no blocker.

## Verdict

Source-fixed in fb33da958e1b8998a661e793d8a5f0a0aa44129a. SlagLog retains the typed nonretryable local-timeout message and a cause that does not erase earlier work. Website mirror and relevant laws pass. This is focused production-function proof; combined gates and actual-app/installed verification remain separate.
