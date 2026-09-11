---
fingerprint: d07d3a35
slug: failed-session-repeats-failed-badge-and-leaves-x
title: Failed session repeats FAILED badge and leaves X steady
surface: sessions
severity: P2
status: open
found: 2026-09-11
lane: agent/session-failed-marker-0910
fix:
origin: owner
report: Screenshot 2026-09-10 205602.png and owner request for flashing failure X without FAILED subtitle
affected: Source 61528ba95 and reported 0.11.2 canary UI
family: session-status-presentation
installer: unverified
recovery: unconfirmed
---

# Failed session repeats FAILED badge and leaves X steady

## Symptom

A failed session displays a steady crossed lamp and a separate FAILED pill under its title. The owner expects a flashing X and the normal compact row.

## Repro

1. Open a station with a session whose recorded latest run failed.
2. View that session in the compact sessions rail.
3. Observe the steady X and extra FAILED subtitle. This applies to any failed session; the QA-generated 0.11.2 persistence session title does not select a special renderer.

## Evidence

Anchors: frontend/app/app.js:3578; frontend/css/glass-demo.css:288; test/session-indicators.test.js.

Before live seeded :18927 receipt: `{meta:"FAILED",animation:"none",row:"ws-row sel attn",display:"grid"}`. After: `{meta:"now",animation:"gd-session-failure",row:"ws-row sel",display:"flex"}`. Failure remains in aria-label and tooltip. Evidence files in owned worktree: dev/failed-before.log, dev/failed-after.log, dev/failed-lifecycle.log.

QA title provenance: qa/evidence/0.11.2-merge-audit/closeout/once-completed-ui.json records the one-time persistence check as a completed routine. Its presence is test data; neither the failed renderer nor its CSS is dev-only.

## Verdict

Failure incorrectly reused the live attention-row flag and the glass failed X had no animation. The change returns normal relative-time metadata, leaves pending prompts distinct, and animates the crossed lamp with reduced-motion support. Focused tests: session indicators 38, approval 8, consent visibility 24 assertions green. Full gate pending. Installed delivery and owner recovery unverified.

## Regression

Before: the original steady X plus FAILED subtitle reproduced in the seeded running app before editing.

After: compact and inbox layouts use the failed X with no FAILED metadata; opacity changes while motion is enabled, reduced motion stops it, and the failed state survives a persisted reload. In-place approval, connecting, running and success transitions clear or replace the failure signal.

## Sibling coverage

{
  "adapters": [
    {
      "target": "recorded failed run and successful retry",
      "state": "covered",
      "test": "test/session-indicators.test.js",
      "scenario": "run outcome reduction and retry signal",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "session and project row status/tooltip projection",
      "state": "covered",
      "test": "test/session-indicators.test.js",
      "scenario": "shared failure status with project tooltip",
      "gate": "fast"
    },
    {
      "target": "approval and reply",
      "state": "covered",
      "test": "test/consent-visibility.test.js",
      "scenario": "pending prompts retain visible action labels",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "compact, inbox, motion and reduced motion",
      "state": "blocked",
      "reason": "Live DOM lifecycle checks passed; full automated browser geometry scenario is not registered. Installed canary not rebuilt."
    }
  ],
  "lifecycle": [
    {
      "target": "save hydration and retry",
      "state": "covered",
      "test": "test/session-indicators.test.js",
      "scenario": "failure survives hydration and a new run replaces stale signal",
      "gate": "fast"
    }
  ]
}
