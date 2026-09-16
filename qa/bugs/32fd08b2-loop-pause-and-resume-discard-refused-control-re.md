---
fingerprint: 32fd08b2
slug: loop-pause-and-resume-discard-refused-control-re
title: Loop pause and resume discard refused control responses
surface: autonomy
severity: P2
status: fixed
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix: b5c5cba75
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Loop pause and resume discard refused control responses

## Symptom

A failed Pause request offers no error or retry feedback, leaving the user to infer whether the loop stopped.

## Repro

Run the fault proxy and click loop PAUSE. It records the request and returns HTTP 409 with a review-busy error. UI retains loops running and Pause, with no notification.

See qa/seam-audit-0912/REPORT.md finding A6 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/windows/loops.js:381. Receipt: `loop-pause-error-hidden` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Final-source live HTTP 409 showed the refusal, preserved the review draft and left Pause available. Controls check acknowledgements, fence stale reads and bound the pending wait. Evidence: qa/seam-audit-0912/repair-ui-observations.json. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.

## Regression

qa/seam-audit-0912/repair-ui-observations.json
