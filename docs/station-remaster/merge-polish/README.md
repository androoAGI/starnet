# Remaster merge preparation — 2026-09-15

Candidate: `ec49c89b9`; application source `6d18e5f67` (source lock committed in `f7005d891`). Later changes correct test expectations for shell materials and transparent viewport glass.
Integration snapshot: `b4e99c0fb0d5bb49a1257394f5115a3da5cb5d68`.
Branch: `agent/prop-coordination-0914`. No merge into trunk or publication was performed.

## Corrections

- Southbound doorway turns now clear the visible raised north wall face and side jambs, not merely the logical walkable tile. The physical segment check is used by path smoothing and live foot movement; narrow corridors and occupied tile dimensions are unchanged.
- Lighting preparation previously ran twice per frame. The composite now reuses the prepared frame unless explicit input, configuration changes or context recovery require preparation. Tests cover these invalidation paths.
- Integrated the current material catalog while retaining remastered crowns, viewport framing and surface art. Every shell passes its material ID and resolved paint to both plate and skirt. Optional missing art retains that material's original recipe.
- Added a saved-layout regression preserving rooms, belts, assignments, metadata and all ordinary prop placements. The intentional legacy tactical-table migration remains covered separately. Repeated loading is idempotent.

## Live evidence

The audit is an isolated seeded localhost station. It does not write the user's real saves.

- `doorway-live.json`: 12 actual entry/departure walks, both shoulders and directions, all arrived, zero sampled crossings of the visible north face.
- `seating-live.json`: 42 actual approach/sit/departure cycles; no recorded seating, facing, claim-release or arrival issues. This is not exhaustive across every skin/prop combination.
- `large-layout-soak.json`: six 20-second windows with 188 props. No observed rendering faults or failed assets; raster, appearance and lighting caches stayed bounded and unchanged between windows. The callback p95 was about 31–32 ms, so this is not a locked-60-fps claim.
- `optimized-large-layout.json`: post-fix preparation count equals rendered lighting frame count (6247 each), confirming duplicate work was removed. Timing was measured while full test suites were running and is not a controlled FPS comparison.
- The normal 159-prop station on port 18797 was restarted without replacing its save and reloaded successfully with ONLINE / LIVE status.
- `default-station.png` and `window-960.png`: normal and 960×640 cinema rendering. No browser warnings/errors were observed after reload; the temporary viewport override was reset.

## Verification and release boundaries

Focused geometry, path smoothing, physical fit, materials, renderer, lighting and containment checks passed. On the final candidate, the full fast gate passed **804/804**, HTTP passed **117/117**, and customer journeys passed **34/34** (all exit 0). The last 22 graphics tests also passed separately. Syntax checks and `git diff --check` passed. The bug register validates all 150 records.

Local full logs (gitignored): `dev/.scratch-workspace/remaster-merge-polish-final-fast.log`, `remaster-merge-polish-http.log`, and `remaster-merge-polish-final-journeys.log`. `verification.json` records their hashes and final summaries. The HTTP run began at `f7005d891`; the only subsequent tracked change before completion was the viewport test assertion, with no application code changes.

The reviewed art remains selected through `?propSet=projection&skinSet=study`; the study skin selector is localhost-only. This preparation does not silently replace saved crew skin assignments or enable a global artwork rollout. A release must explicitly decide that rollout and validate the installed artifact.

A two-minute soak cannot prove multi-hour stability, every hardware tier or every custom station. Long-duration installed-build testing and release authority (`qa:ready`) remain separate release requirements. No universal zero-bug or release-ready assertion is made here.
