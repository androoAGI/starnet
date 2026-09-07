---
fingerprint: 0ff9dfc6
slug: bay-names-are-unreadable-at-normal-station-zoom
title: Bay names are unreadable at normal station zoom
surface: world
severity: P1
status: fixed
found: 2026-09-06
lane: release-0110
fix: 86560bea9
origin: owner
report: Owner 0.11.0 installer test, 2026-09-06, bay name screenshot
affected: Windows 0.11.0 candidate 2cfdcb04e
family: bay-labels
installer: verified
installerVersion: 0.11.0
installerSha256: 15a7b01c839f3f628bebcc9ae4290d08d42bcc308a8688f396a586e345bde463
installerEvidence: Signed Windows candidate bd65c7737 installed; exact-source smoke 9/9 GREEN, native desktop nameplates visually inspected, and owner accepted the proportional tags.
recovery: confirmed
recoveryEvidence: Owner tested the installed bd65c7737 correction and replied looks great in the release task on 2026-09-06.
---

# Bay names are unreadable at normal station zoom

## Symptom

Agent names on bay monitors are too small and dim to read at normal station zoom.

## Repro

1. Open a station with multiple assigned bays in the reported 0.11.0 installer.
2. Inspect names at normal fitted zoom and with room lighting enabled.
3. Longer names are cut after five characters and the remaining glyphs are barely legible.

## Evidence

Owner bay-name screenshot (2026-09-06). Original frontend/app/propsprites.js used an 8px sprite font, slice(0, 5), and painted names below the lightmap. Live :9188 six-bay fixture now visibly shows NOVA, ULTRON, RESEARCHER, ALIX, RELEASE REVIEW and PROJECT FOLLOWUPS in cinema and REFIT. Readable signs are painted after lighting in both callers. Anchor: test/bay-name-legibility.test.js.

## Verdict

The owner rejected source repair fe5be77a9 in installed candidate 5eb4ac201: its minimum screen size and collision stacking made names dominate the zoomed-out station. Follow-up 86560bea9 restores compact top-mounted tags that scale with each bay, retains the post-lighting contrast improvement, and bounds long names to one line with an ellipsis. Live source preview confirms proportional shrinking at distant zoom. The owner accepted the installed bd65c7737 correction; native Windows inspection also confirms the compact tags on the real station. This does not claim a physical Mac label retest.

## Regression

The original implementation silently discarded the sixth character and rasterized names into the shaded sprite. The executable render recorder now checks complete ULTRON, proportional scaling across five zooms and three device scales, live rename/binding, unassigned bays, fixed anchors without floating stacks, and single-line truncation within the bay footprint. Live follow-up screenshots confirm compact tags at normal scale and shrinking tags at distant zoom; the earlier REFIT proof covered the shared post-lighting entry point.

## Sibling coverage

{
  "adapters": [
    {
      "target": "shared canvas name renderer",
      "state": "covered",
      "test": "test/bay-name-legibility.test.js",
      "scenario": "real renderer emits compact proportional tags, fixed anchors and bay-width-bounded long names",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "live station and REFIT",
      "state": "blocked",
      "reason": "Both live entry points were visually inspected using the seeded six-bay station; there is no registered browser test for these canvas labels."
    }
  ],
  "displays": [
    {
      "target": "zoom and DPR geometry",
      "state": "covered",
      "test": "test/bay-name-legibility.test.js",
      "scenario": "five camera scales across DPR 1, 1.25 and 2",
      "gate": "fast"
    },
    {
      "target": "physical display and installed CRT",
      "state": "blocked",
      "reason": "Windows source browser screenshots were inspected; exact new installer and physical Mac retests remain pending."
    }
  ],
  "lifecycle": [
    {
      "target": "rename, reassign and unassigned",
      "state": "covered",
      "test": "test/bay-name-legibility.test.js",
      "scenario": "new roster projection replaces the old label without reusing a stale cached name",
      "gate": "fast"
    },
    {
      "target": "saved station reload",
      "state": "blocked",
      "reason": "The six-bay fixture survived preview reload; no registered bay-label browser persistence test exists."
    }
  ]
}
