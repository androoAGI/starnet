---
fingerprint: 72da34d7
slug: deleted-rooms-leave-floating-furniture
title: Deleted rooms leave floating furniture
surface: world
severity: P2
status: fixed
found: 2026-09-10
lane: doorway-occlusion-0910
fix: 35d255dbd
origin: audit
affected: Source 343238e68; isolated Windows browser
installer: unverified
recovery: unconfirmed
---

# Deleted rooms leave floating furniture

## Symptom

Deleting a room leaves its furniture drawn over empty space and saved in the station.

## Repro

Place a furnished middle room between two others, delete it, render, then undo and redo. Include a belt, a boundary-straddling prop and neighboring-room furniture.

## Evidence

Before at 343238e68: floorUnderDesk=false while actual PropSprites.draw still rendered desk p4; rebuilding the room retained that desk. After: no deleted-desk draw, neighboring furniture retained, belt removed, one undo restored the exact complete document, redo and reload kept it deleted. test/world-lifecycle.test.js also covers spawn-room refusal and preservation of independent agent-level links.

## Verdict

The model removed only the room. It now removes props losing floor support and belt tiles on that deck in the same undo snapshot. Agent-level logical links remain independent; undo restores assignments and stable IDs. Source verified in the seeded app; installed desktop and user-layout recovery are unverified.

## Regression

Before at 343238e68: floorUnderDesk=false while actual PropSprites.draw still rendered desk p4; rebuilding the room retained that desk. After: no deleted-desk draw, neighboring furniture retained, belt removed, one undo restored the exact complete document, redo and reload kept it deleted. test/world-lifecycle.test.js also covers spawn-room refusal and preservation of independent agent-level links.

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
