---
fingerprint: 32fd08b2
slug: loop-pause-and-resume-discard-refused-control-re
title: Loop pause and resume discard refused control responses
surface: autonomy
severity: P2
status: open
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix:
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

Open audit finding. No product fix or customer recovery is claimed.
