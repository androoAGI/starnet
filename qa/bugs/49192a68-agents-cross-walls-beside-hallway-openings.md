---
fingerprint: 49192a68
slug: agents-cross-walls-beside-hallway-openings
title: Agents cross walls beside hallway openings
surface: world
severity: P1
status: fixed
found: 2026-09-10
lane: doorway-occlusion-0910
fix: a22f780e3
origin: owner
report: Owner report in Codex on 2026-09-09: agents walk behind walls near hallway doors and openings
affected: Reported build unknown; reproduced against 0.11.1 source at 83c896e7d
family: doorway-movement
installer: unverified
recovery: unconfirmed
---

# Agents cross walls beside hallway openings

## Symptom

Agents appear to walk behind walls beside hallway doors and other openings.

## Repro

Build two rooms connected by an east/west hallway and a third room connected by a north/south hallway. Send agents diagonally across the openings in both directions. Independently sample rendered foot positions against walkable tiles and canStep at each crossed seam. Regression: test/path-smoothing.test.js.

## Evidence

Live seeded app at localhost:9294, source 83c896e7d: 1,600 deterministic route pairs produced 588 invalid rendered-foot segments. The same live model probe after the source repair produced zero. The prior route smoother checked tile centres while world.js footOf anchors feet at y*T+T-1. Early waypoint handoffs also cut unvalidated corners. Updated test/path-smoothing.test.js passes 22 assertions including real world helper execution.

## Verdict

Source-fixed by a22f780e3. The path checker uses actual feet; early turns require a clear segment; off-anchor starts realign within their tile; separation cannot cross a wall or invalidate a remaining leg. Installed build and reporter recovery remain unverified.

## Regression

Before: the same live seeded browser test against 83c896e7d recorded wall violations in four of eight hero/crew routes (53, 10, 54 and 10 invalid movement samples). Route-only sampling found 588 invalid segments across 1,600 deterministic pairs.

After: the repaired seeded app completed all twelve routes across east/west and north/south openings in both directions for hero, idle crew and workstation crew. Every route reached its destination with zero illegal foot tiles or wall crossings. This drove the shipped movement functions through temporary browser-only test hooks; no production test hook was added. Canvas readback was opaque [53,49,47,255], with rendered foot/head positions and sprite poses present; browser warnings and exceptions were empty. The 1,600-pair live model probe fell to zero invalid segments. Regression test: test/path-smoothing.test.js (22 assertions), with independently sampled feet plus production corner/start/nudge helpers. test/crew-containment.test.js: 23 assertions. Customer-journey gate: 34/34 green, exit 0. Full fast gate on committed candidate 57df448af: 752/752 green, exit 0.

## Sibling coverage

{
  "adapters": [
    {
      "target": "hero, idle crew and workstation crew movement",
      "state": "covered",
      "test": "test/path-smoothing.test.js",
      "scenario": "early waypoint handoffs stay on floor and cross only real openings; all three movement branches call the corner guard",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "diagonal doorway routes and starts between tile anchors",
      "state": "covered",
      "test": "test/path-smoothing.test.js",
      "scenario": "rendered feet never cross solid doorway seams, void or furniture; unsafe initial shortcut aligns in its own tile",
      "gate": "fast"
    },
    {
      "target": "body separation at sealed room boundary",
      "state": "covered",
      "test": "test/path-smoothing.test.js",
      "scenario": "separation cannot shove a body through a solid seam",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "browser and desktop frontend source",
      "state": "covered",
      "test": "test/path-smoothing.test.js",
      "scenario": "rendered-foot geometry and all three production movement branches",
      "gate": "fast"
    },
    {
      "target": "website mirror",
      "state": "covered",
      "test": "test/website-app-sync.test.js",
      "scenario": "frontend mirror remains synchronized",
      "gate": "fast"
    },
    {
      "target": "installed desktop artifact",
      "state": "blocked",
      "reason": "No rebuilt installed artifact was exercised; source live proof is from the seeded browser app."
    }
  ],
  "lifecycle": [
    {
      "target": "station geometry re-projection",
      "state": "covered",
      "test": "test/path-smoothing.test.js",
      "scenario": "fresh room and hallway geometry, sealed room projection, and off-anchor path starts",
      "gate": "fast"
    },
    {
      "target": "saved station restart on reporter layout",
      "state": "blocked",
      "reason": "The affected saved layout and a rebuilt installer were not supplied; reporter recovery requires a retest."
    }
  ]
}
