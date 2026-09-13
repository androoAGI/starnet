---
fingerprint: 2b5b18a3
slug: loop-polling-erases-the-rejection-explanation-be
title: Loop polling erases the rejection explanation being typed
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

# Loop polling erases the rejection explanation being typed

## Symptom

A typed rejection explanation vanishes and its editor closes while the user is composing it.

## Repro

Run the local fault proxy, open Automation Goal loops, click REJECT on the candidate, type a reason, and let the four-second refresh run. UI reads change from the typed text with hidden false to empty with hidden true.

See qa/seam-audit-0912/REPORT.md finding A5 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/windows/loops.js:303. Receipt: `loop-review-draft-reset` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Open audit finding. No product fix or customer recovery is claimed.
