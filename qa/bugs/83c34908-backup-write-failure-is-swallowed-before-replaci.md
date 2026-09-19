---
fingerprint: 83c34908
slug: backup-write-failure-is-swallowed-before-replaci
title: Backup write failure is swallowed before replacing the committed primary
surface: sessions
severity: P1
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Backup write failure is swallowed before replacing the committed primary

## Symptom

The catch for JSON parsing also swallowed backup filesystem errors, so a failed snapshot did not prevent primary replacement.

## Repro

Inject ENOSPC into the backup durable writer. Before: new primary replaces version 1 despite failed backup. After: ENOSPC is propagated and version 1 remains.

## Evidence

`test/durable-store-faults.test.js`; `qa/evidence/systemic-bugs-0919/`. Actual HTTP restart coverage: `test/durable-store-faults.http.test.js`.

## Verdict

Parsing and backup I/O have separate failure boundaries. The shared primitive preserves the committed primary when its required recovery snapshot fails. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
