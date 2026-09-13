---
fingerprint: a496d1c7
slug: routine-form-provider-overrides-its-selected-age
title: Routine form provider overrides its selected agent provider
surface: providers
severity: P1
status: fixed
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix: b54b44574
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Routine form provider overrides its selected agent provider

## Symptom

A routine assigned to one provider-configured agent can retain the global station provider instead, producing a mixed execution configuration.

## Repro

Give a selected agent provider codex while the form station provider is openrouter. The UI sends the station value as job.provider; actual cronProviderFor resolves openrouter instead of codex. Paid dispatch remains unverified.

See qa/seam-audit-0912/REPORT.md finding A4 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/windows/routines.js:622. Receipt: `routine-station-provider-overrides-selected-agent` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Routine and goal-loop forms omit the implicit station-provider override. UI and HTTP persistence retain null for agent-provider inheritance. Paid multi-provider dispatch was not tested. Evidence: test/seam-audit-recovery.http.test.js. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.

## Regression

test/seam-audit-recovery.http.test.js
