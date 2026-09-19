---
fingerprint: 7aeb7f9f
slug: temporarily-unreadable-durable-records-can-be-qu
title: Temporarily unreadable durable records can be quarantined or overwritten
surface: sessions
severity: P1
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Temporarily unreadable durable records can be quarantined or overwritten

## Symptom

A read error entered the destructive corruption callback, and full-state writers bypassed the update guard. Torn primary plus unreadable sole backup was also misclassified.

## Repro

Run the five-errno by four-file-state matrix and the real-sidecar widget fault/restart test. Original source passed 20/122 assertions; repaired source passes 122/122.

## Evidence

`test/durable-store-faults.test.js`; `qa/evidence/systemic-bugs-0919/`. Actual HTTP restart coverage: `test/durable-store-faults.http.test.js`.

## Verdict

Read failure is now distinct from corrupt bytes for every shared-store caller; all shared writers refuse inaccessible authority. Real-sidecar widget definitions survive four fault/restart variants. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
