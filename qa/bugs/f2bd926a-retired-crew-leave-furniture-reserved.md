---
fingerprint: f2bd926a
slug: retired-crew-leave-furniture-reserved
title: Retired crew leave furniture reserved
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

# Retired crew leave furniture reserved

## Symptom

A couch appears empty after its occupant is removed, but another crew member cannot sit there.

## Repro

Seat a summoned crew member on a three-wide couch, despawn it, and ask another member to claim that cushion. Also remove a non-summoned body by reconciling an empty routing plan.

## Evidence

Before at 343238e68: despawn succeeded but p2:1 remained in occupiedSeats; both replacement attempts returned false. After: the live nine-check lifecycle probe recorded an empty reservation set and successful replacement seating. test/world-lifecycle.test.js executes the production removal and no-bays reconciliation methods.

## Verdict

The body was discarded before releasing its seat. Summoned removal, floor-load plan removal and both routing reconciliation removal paths now release the departing body first. Source verified in the seeded app; installed desktop and user-layout recovery are unverified.

## Regression

Before at 343238e68: despawn succeeded but p2:1 remained in occupiedSeats; both replacement attempts returned false. After: the live nine-check lifecycle probe recorded an empty reservation set and successful replacement seating. test/world-lifecycle.test.js executes the production removal and no-bays reconciliation methods.

## Sibling coverage

{
  "adapters": [
    {
      "target": "browser world state",
      "state": "covered",
      "test": "test/world-lifecycle.test.js",
      "scenario": "production model or crew-state helpers",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "world lifecycle mutations",
      "state": "covered",
      "test": "test/world-lifecycle.test.js",
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
      "test": "test/world-lifecycle.test.js",
      "scenario": "removal, undo, redo and reload",
      "gate": "fast"
    }
  ]
}
