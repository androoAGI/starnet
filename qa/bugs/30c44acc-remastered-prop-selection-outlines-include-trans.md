---
fingerprint: 30c44acc
slug: remastered-prop-selection-outlines-include-trans
title: Remastered prop selection outlines include transparent packing
surface: world
severity: P2
status: fixed
found: 2026-09-16
lane: prop-coordination-0914
fix: 8637c9d8d
origin: owner
report: owner-selection-grid-2026-09-15
affected: Local remaster preview on Windows port 18797
family: prop-selection
installer: unverified
recovery: unconfirmed
---

# Remastered prop selection outlines include transparent packing

## Symptom

The selection rectangle extends well above and around remastered furniture, making its visible size appear misaligned with placement.

## Repro

Open the projection preview on port 18797, enter Refit, place a tactical table and select it. Compare the strong border to the visible table and the reserved floor tiles.

## Evidence

docs/station-remaster/selection-audit/table-selected.png shows the live corrected border. test/remaster-physical-fit.test.js verifies alpha bounds, translation, mounting, caching and fallback. Live desk selection and tactical-table placement/selection were exercised; Undo restored the original 159 object count.

## Verdict

Source fixed: strong outlines use rendered alpha bounds, faint dashed borders retain occupied floor tiles. No art size or collision changes. Installer and owner acceptance remain unverified.

## Regression

Previously drawHover used only x/y/w/h tile rectangles. The new shared selection helper measures oriented rendered masks, ignores alpha below 128 and applies world translation and mounting lift. The focused regression uses independently specified alpha pixels and expected world bounds.

## Sibling coverage

{
  "adapters": [{"target":"rendered prop alpha and unavailable artwork","state":"covered","test":"test/remaster-physical-fit.test.js","scenario":"opaque alpha bounds, soft-glow exclusion and null fallback","gate":"fast"}],
  "entrypoints": [{"target":"selection, hover, new placement and movement preview","state":"blocked","reason":"Selection and new placement verified live; all paths share drawPropSelection, but automated UI coverage of every entry point is absent."}],
  "displays": [{"target":"desk and tactical table","state":"blocked","reason":"Live screenshot proof exists; exhaustive catalog, facing and screen-size visual checks are not automated."}],
  "lifecycle": [{"target":"moving and mounting","state":"covered","test":"test/remaster-physical-fit.test.js","scenario":"world translation and mounting lift reuse cached alpha bounds","gate":"fast"},{"target":"complete catalog cache invalidation","state":"blocked","reason":"Existing rendered mask cache handles style reload; this repair does not exhaustively exercise every texture reload in browser."}]
}
