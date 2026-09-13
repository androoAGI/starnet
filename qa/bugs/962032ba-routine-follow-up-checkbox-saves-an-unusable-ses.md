---
fingerprint: 962032ba
slug: routine-follow-up-checkbox-saves-an-unusable-ses
title: Routine follow-up checkbox saves an unusable session origin
surface: autonomy
severity: P1
status: open
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix:
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Routine follow-up checkbox saves an unusable session origin

## Symptom

A saved routine with follow-up enabled is rejected by the scheduler because it has no captured conversation.

## Repro

In New schedule leave Keep in StarNet selected, check Allow follow-up, fill name and prompt, save. Inspect job: attachToSession true, origin null. Actual cronPreflightConfig returns missing-session-origin. This persisted through an isolated sidecar restart.

See qa/seam-audit-0912/REPORT.md finding A3 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/windows/routines.js:653. Receipt: `routine-follow-up-without-origin` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Open audit finding. No product fix or customer recovery is claimed.
