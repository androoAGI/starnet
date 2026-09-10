---
fingerprint: e356ce13
slug: agent-look-back-flicker-and-waypoint-stutter
title: Agent look-back flicker and waypoint stutter
surface: world
severity: P2
status: fixed
found: 2026-09-10
lane: skin-motion-0910
fix: 75a814c18
origin: owner
report: Codex owner report 2026-09-10: agents jitter, stutter and seem indecisive while walking
affected: Windows local seeded preview at ae3029b51; reproduced after sync to 343238e68
family: movement-continuity
installer: unverified
recovery: unconfirmed
---

# Agent look-back flicker and waypoint stutter

## Symptom

Agents rapidly reverse facing while pausing and briefly stall when switching route segments.

## Repro

Run node dev/seed.js --keep on port 9241, then node dev/movement-probe.mjs. The browser probe captures real rendered bodies, holds a look-back, and advances through an intermediate waypoint. Regression: test/world-movement-continuity.test.js executes all three shipped movement branches.

## Evidence

Before: live browser trace alternated west/east on all 25 sampled frames during one look-back. After: all sampled frames held west. The live route advanced from x=113 to x=114.010684 on its first sampled frame and to x=143.765342 over 44 frames. Local receipts: .worldshots/movement-before.json, movement-after.json and movement-route-after.json. Source anchor: frontend/app/world.js, maybeStrollBeat and the three walking branches.

## Verdict

The look-back direction is latched when the pause starts; waypoint transitions consume no empty frame. Intentional pauses, final arrival braking and doorway collision guards remain active. Source-fixed in 75a814c18. Before/after regression: the baseline fails seven assertions; the repaired source passes all 15. Installed build and owner recovery remain unverified.

## Regression

`test/world-movement-continuity.test.js` covers held look-back facing, same-frame waypoint travel, blocked corners, pause/resume and work priority. `test/path-smoothing.test.js` covers wall-safe segments; `test/world-seat-recovery.test.js` covers unreachable desks and refit recovery.

## Sibling coverage

{
  "adapters": [
    {
      "target": "hero and idle crew",
      "state": "covered",
      "test": "test/world-movement-continuity.test.js",
      "scenario": "look-back holds the opposite direction",
      "gate": "fast"
    },
    {
      "target": "workstation crew",
      "state": "covered",
      "test": "test/world-movement-continuity.test.js",
      "scenario": "workstation route advances through waypoint without an idle frame or leisure pause",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "waypoint and paused movement",
      "state": "covered",
      "test": "test/world-movement-continuity.test.js",
      "scenario": "resumes the committed route after the hold",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "website mirror",
      "state": "covered",
      "test": "test/website-app-sync.test.js",
      "scenario": "frontend mirror remains synchronized",
      "gate": "fast"
    },
    {
      "target": "installed desktop",
      "state": "blocked",
      "reason": "This lane verifies local source; no installed build was updated."
    }
  ],
  "lifecycle": [
    {
      "target": "route interruption by deliberate pause",
      "state": "covered",
      "test": "test/world-movement-continuity.test.js",
      "scenario": "newly armed pause is respected at handoff",
      "gate": "fast"
    }
  ]
}
