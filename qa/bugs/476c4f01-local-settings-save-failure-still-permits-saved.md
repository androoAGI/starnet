---
fingerprint: 476c4f01
slug: local-settings-save-failure-still-permits-saved
title: Local settings save failure still permits saved confirmation
surface: world
severity: P2
status: fixed
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix: b54b44574
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Local settings save failure still permits saved confirmation

## Symptom

Local preference controls can report saved after storage rejected the write; the in-memory setting can revert on reload.

## Repro

Execute actual stationui save with localStorage.setItem throwing. It returns without an error; appearance and notification callers unconditionally flashSaved. Actual disk-full UI was not tested.

See qa/seam-audit-0912/REPORT.md finding A8 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/stationui.js:180. Receipt: `settings-save-failure-swallowed` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Real UI storage exception produced an unsaved warning; restored storage showed saved and survived reload. Independent OS settings acknowledgements stay independent. Evidence: test/settings-save-failure.test.js. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.

## Regression

test/settings-save-failure.test.js
