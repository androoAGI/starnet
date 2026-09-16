---
fingerprint: 6b655b46
slug: startup-history-read-failure-skips-away-work-rev
title: Startup history read failure skips away-work review recovery
surface: sessions
severity: P1
status: fixed
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix: b5c5cba75
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Startup history read failure skips away-work review recovery

## Symptom

A failed first history read leaves a completed away run absent from the pending review list even after the next successful boot.

## Repro

Seed lastSeenAt=1000 and a done run at 2000. Boot at 3000 with a rejected history read, then at 4000 with that run returned. Both pending lists stay empty.

See qa/seam-audit-0912/REPORT.md finding A1 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/returnstore.js:78. Receipt: `away-read-failure-loses-recovery-boundary` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Closed intervals survive failed reads, restart and failed persistence; attended work is excluded. Live recovery fixture passed. Evidence: test/returnstore-recovery.test.js. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.

## Regression

test/returnstore-recovery.test.js
