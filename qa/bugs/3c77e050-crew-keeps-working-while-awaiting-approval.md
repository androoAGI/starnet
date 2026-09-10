---
fingerprint: 3c77e050
slug: crew-keeps-working-while-awaiting-approval
title: Crew keeps working while awaiting approval
surface: world
severity: P2
status: open
found: 2026-09-10
lane: doorway-occlusion-0910
fix:
origin: audit
affected: Source 343238e68; isolated Windows browser
installer: unverified
recovery: unconfirmed
---

# Crew keeps working while awaiting approval

## Symptom

A crew member keeps moving or working while its run is waiting for consent.

## Repro

Run an ASK-mode crew shell task through the real sidecar and hold its permission prompt. Inspect the server pending-prompt snapshot and the browser body; approve or deny and let the run finish.

## Evidence

Before at 343238e68: the real isolated sidecar reported a pending prompt while the browser body had working=true and a walking pose. After: pending=true, working=false, waitingApproval=true, standing pose; approving ran the real shell and terminal cleanup returned working=false. Live artifacts are approval-before.json and approval-after.json in the lane evidence directory. test/world-crew-approval.test.js covers duplicates, concurrent prompts, another crew member, cancellation, snapshot recovery and the actual tag renderer.

## Verdict

Only the lead consumed permission events. Crew now holds position with an amber approval tag; prompt IDs isolate overlapping waits, matching responses resume proven live work, and terminal, snapshot and TTL paths clear stale waits. Working glow, bay lights, clocks and glyphs are suppressed while paused. Source verified in the seeded app; installed desktop and user-layout recovery are unverified.

## Regression

Before at 343238e68: the real isolated sidecar reported a pending prompt while the browser body had working=true and a walking pose. After: pending=true, working=false, waitingApproval=true, standing pose; approving ran the real shell and terminal cleanup returned working=false. Live artifacts are approval-before.json and approval-after.json in the lane evidence directory. test/world-crew-approval.test.js covers duplicates, concurrent prompts, another crew member, cancellation, snapshot recovery and the actual tag renderer.

## Sibling coverage

{
  "adapters": [
    {
      "target": "browser world state",
      "state": "covered",
      "test": "test/world-crew-approval.test.js",
      "scenario": "production model or crew-state helpers",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "world lifecycle mutations",
      "state": "covered",
      "test": "test/world-crew-approval.test.js",
      "scenario": "accepted events and mutations plus unrelated-body isolation",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "installed desktop",
      "state": "blocked",
      "reason": "Source browser verified; installed binary was not rebuilt or exercised."
    }
  ],
  "lifecycle": [
    {
      "target": "cleanup and recovery",
      "state": "covered",
      "test": "test/world-crew-approval.test.js",
      "scenario": "matching prompts, cancellation and snapshot recovery",
      "gate": "fast"
    }
  ]
}
