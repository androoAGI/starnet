---
fingerprint: c66e8c39
slug: agent-loop-pause-leaves-cancelled-iteration-runn
title: Agent loop pause leaves cancelled iteration running and lease held
surface: autonomy
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

# Agent loop pause leaves cancelled iteration running and lease held

## Symptom

Agent-command pause can show the loop paused while its iteration remains running and prevents ordinary progress.

## Repro

Start a loop with an unresolved provider promise; call actual modelControlLoop pause; resolve the provider after abort. The iteration remains running and leases.size is 1. Reference abortLease settles cancelled and releases ownership.

See qa/seam-audit-0912/REPORT.md finding A2 for exact scope and repair criteria.

## Evidence

Code anchor: sidecar/index.js:7315. Receipt: `loop-agent-pause` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Pause, Stop and Remove settle through the host driver and survive late resolution/rejection. Replacement and durable retry behavior covered by driver tests. Evidence: test/model-loop-control.test.js and test/loopjob-driver.test.js. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.

## Regression

test/model-loop-control.test.js and test/loopjob-driver.test.js
