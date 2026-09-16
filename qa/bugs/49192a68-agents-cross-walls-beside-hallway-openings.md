---
fingerprint: 49192a68
slug: agents-cross-walls-beside-hallway-openings
title: Agents cross walls beside hallway openings
surface: world
severity: P1
status: fixed
found: 2026-09-10
lane: wall-clearance-0916
fix: 2dbc0ef5a
origin: owner
report: Owner reports in Codex on 2026-09-09 and 2026-09-16: agents disappear into both wall shoulders beside hallway openings
affected: Reported build unknown; latest recurrence reproduced on remastered source 67eb99bdf
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

2026-09-16 recurrence: the rendered doorway returns extend 30px above the logical room seam and up to 7px inside each corridor edge. The earlier floor-face guard only reserved 2.5px at corridor sides. In the seeded browser app on source 67eb99bdf, 500 deterministic routes yielded 243 samples with feet inside opaque door-occluder pixels. Screenshot supplied by the owner circles both affected shoulders.

Owner reported a south-entry recurrence during remaster merge preparation. The earlier fix checked logical floor but allowed early turns inside the nine-pixel north wall face. d50f3f603 adds continuous visible-face clearance, including side walls, to the actual-foot path and corner guard. Live receipt: docs/station-remaster/merge-polish/doorway-live.json (12/12 arrivals, zero north-face crossings). test/path-smoothing.test.js now passes 27 assertions including premature south-entry turns and reverse traversal.

Live seeded app at localhost:9294, source 83c896e7d: 1,600 deterministic route pairs produced 588 invalid rendered-foot segments. The same live model probe after the source repair produced zero. The prior route smoother checked tile centres while world.js footOf anchors feet at y*T+T-1. Early waypoint handoffs also cut unvalidated corners. Updated test/path-smoothing.test.js passes 22 assertions including real world helper execution.

## Verdict

Latest recurrence source-fixed by 2dbc0ef5a: navigation now reserves the full raised doorway passage, moves waypoint feet inward in narrow halls, and validates raw BFS legs as well as shortcuts and nudges. Renderer waypoints use the same model anchors. The fix preserves floor occupancy and doorway access; it does not hide clipping with a draw-order change.

Original logical-seam repair: a22f780e3. Visible wall-face recurrence source-fixed by d50f3f603. The path checker uses actual feet; early turns require a clear segment outside the raised face; off-anchor starts realign within their tile; separation cannot cross a wall or invalidate a remaining leg. Installed build and reporter recovery remain unverified.

## Regression

2026-09-16 source repair 2dbc0ef5a: the identical 500-route baked-pixel probe produces zero overlaps. Real hero and crew navigation completed 16 traversals across both sides and directions of two- and four-tile north openings: 4,868 animation frames, all destinations reached, zero overlaps between the 9px-wide body envelope and opaque raised-wall pixels. Canvas readback [32,30,30,255]. Probe uses the production path planner, steppers, corner guard and rendered wall canvases in an isolated dev-seeded browser; accelerated actor pace is fixture setup. Local receipts: .dogfood/live.json and .dogfood/live.log in the wall-clearance-0916 worktree. test/path-smoothing.test.js now passes 78 assertions, including sprite-width doorway lanes at widths 2/3/4, reverse routes and serialized geometry restoration. Worldmodel 586, containment 23 and seating 82 assertions pass. Installer and original reporter retest remain unverified.

Before: the same live seeded browser test against 83c896e7d recorded wall violations in four of eight hero/crew routes (53, 10, 54 and 10 invalid movement samples). Route-only sampling found 588 invalid segments across 1,600 deterministic pairs.

After: the repaired seeded app completed all twelve routes across east/west and north/south openings in both directions for hero, idle crew and workstation crew. Every route reached its destination with zero illegal foot tiles or wall crossings. This drove the shipped movement functions through temporary browser-only test hooks; no production test hook was added. Canvas readback was opaque [53,49,47,255], with rendered foot/head positions and sprite poses present; browser warnings and exceptions were empty. The 1,600-pair live model probe fell to zero invalid segments. Regression test: test/path-smoothing.test.js (22 assertions), with independently sampled feet plus production corner/start/nudge helpers. test/crew-containment.test.js: 23 assertions. Customer-journey gate: 34/34 green, exit 0. Full fast gate on committed candidate 57df448af: 752/752 green, exit 0. Exact merged commit 9e5b6d88e also passed all 752 steps in the isolated checkout; receipt: qa/digests/2026-09-10-doorway-movement.md.

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
      "scenario": "rendered feet never cross solid doorway seams, void or furniture; sprite-width lanes clear raised jambs at widths 2/3/4 in both directions; unsafe initial shortcut aligns in its own tile",
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
      "scenario": "fresh room and hallway geometry, sealed room projection, off-anchor path starts, and serialized doorway-anchor restoration",
      "gate": "fast"
    },
    {
      "target": "saved station restart on reporter layout",
      "state": "blocked",
      "reason": "The affected saved layout and a rebuilt installer were not supplied; reporter recovery requires a retest."
    }
  ]
}
